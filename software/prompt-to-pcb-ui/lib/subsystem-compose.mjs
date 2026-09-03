/**
 * Subsystem composition — the deterministic core of hierarchical board design.
 *
 * Why this exists. Today the whole board comes out of ONE model call
 * (`emitPartsNets` in app/api/electronics-cs/route.ts): every part and every
 * connection, in a single shot. That is the real reason complexity tops out
 * around 25 parts. No model reliably emits 200 parts and 300 correct nets at
 * once, and there is no way to check whether it did — a missed connection just
 * looks like a slightly different netlist.
 *
 * The fix is to design each subsystem separately against an INTERFACE CONTRACT
 * and then join them. That only works if joining is exact and checkable, which
 * is what this module is: pure, synchronous, deterministic, no I/O and no model
 * calls, so every composition can be proven correct offline and every failure
 * has a name instead of a stack trace.
 *
 * The output `{parts, nets, gnd}` is EXACTLY the shape tools/tscircuit/run_board.mjs
 * already consumes, so a composed board feeds straight into the existing
 * placement + routing path with no adapter.
 *
 * Deliberately NOT in here: anything that talks to a model. Generation is the
 * caller's job; `splitForGeneration()` hands it the per-subsystem briefs.
 */

/** @typedef {{ signal: string, net: string }} Port */
/** @typedef {{ severity: 'error'|'warning', code: string, message: string, subsystem?: string, signal?: string, ref?: string }} Problem */

const isStr = (v) => typeof v === 'string' && v.length > 0
const refOf = (endpoint) => String(endpoint).split('.')[0]

/**
 * A short, stable, KiCad-safe prefix for a subsystem.
 *
 * Namespacing matters because two independently designed subsystems will BOTH
 * call their first chip U1 — that is not a mistake, it is the point of
 * designing them separately. Prefixing is done here, once, rather than asking
 * each generator to pick globally unique names (which reintroduces the global
 * coordination we are trying to remove).
 *
 * Uppercase alphanumerics only, because the reference designator ends up in a
 * netlist, a BOM and on silkscreen.
 */
function prefixFor(name, taken) {
  const clean = String(name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const base = (clean.slice(0, 3) || 'SUB')
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  // Deterministic disambiguation: lengthen first (POW -> POWE), then number.
  for (let n = 4; n <= clean.length; n++) {
    const longer = clean.slice(0, n)
    if (!taken.has(longer)) {
      taken.add(longer)
      return longer
    }
  }
  for (let i = 2; i < 1000; i++) {
    const numbered = `${base}${i}`
    if (!taken.has(numbered)) {
      taken.add(numbered)
      return numbered
    }
  }
  return base // unreachable in practice; caller reports prefix_collision
}

/** Rewrite "U1.3" -> "PWR_U1.3", preserving the pin exactly. */
const nsEndpoint = (prefix, endpoint) => {
  const s = String(endpoint)
  const dot = s.indexOf('.')
  return dot === -1 ? `${prefix}_${s}` : `${prefix}_${s.slice(0, dot)}${s.slice(dot)}`
}

/**
 * Compose independently designed subsystems into one board netlist.
 *
 * @param {Array<{name: string, purpose?: string, parts?: Array<object>, nets?: Array<[string,string]>, gnd?: string[], provides?: Port[], requires?: Port[]}>} subsystems
 * @param {{ requireEveryProvideUsed?: boolean }} [opts]
 * @returns {{ parts: object[], nets: [string,string][], gnd: string[], interfaces: object[], problems: Problem[], stats: object }}
 */
export function composeSubsystems(subsystems, opts = {}) {
  /** @type {Problem[]} */
  const problems = []
  const push = (severity, code, message, extra = {}) => problems.push({ severity, code, message, ...extra })

  const list = Array.isArray(subsystems) ? subsystems : []
  if (!list.length) {
    push('error', 'no_subsystems', 'nothing to compose: the subsystem list is empty')
    return { parts: [], nets: [], gnd: [], interfaces: [], problems, stats: { subsystems: 0, parts: 0, nets: 0 } }
  }

  // --- prefixes -------------------------------------------------------------
  const taken = new Set()
  const prefixes = []
  const seenNames = new Set()
  for (const sub of list) {
    const name = isStr(sub?.name) ? sub.name : ''
    if (!name) push('error', 'unnamed_subsystem', 'a subsystem has no name; it cannot be namespaced or reported on')
    if (name && seenNames.has(name)) {
      push('error', 'duplicate_subsystem', `two subsystems are both called "${name}"`, { subsystem: name })
    }
    seenNames.add(name)
    const before = taken.size
    const p = prefixFor(name || `SUB${prefixes.length + 1}`, taken)
    if (taken.size === before) {
      push('error', 'prefix_collision', `subsystem "${name}" could not be given a unique reference prefix (got "${p}")`, { subsystem: name })
    }
    prefixes.push(p)
  }

  // --- parts ----------------------------------------------------------------
  const parts = []
  /** subsystem index -> Set of local part names */
  const localParts = []
  for (let i = 0; i < list.length; i++) {
    const sub = list[i]
    const prefix = prefixes[i]
    const subName = sub?.name ?? `#${i}`
    const own = new Set()
    const subParts = Array.isArray(sub?.parts) ? sub.parts : []
    if (!subParts.length) {
      push('warning', 'empty_subsystem', `subsystem "${subName}" contributes no parts`, { subsystem: subName })
    }
    for (const part of subParts) {
      const nm = isStr(part?.name) ? part.name : ''
      if (!nm) {
        push('error', 'unnamed_part', `subsystem "${subName}" has a part with no name`, { subsystem: subName })
        continue
      }
      if (own.has(nm)) {
        push('error', 'duplicate_part', `subsystem "${subName}" declares "${nm}" more than once`, { subsystem: subName, ref: nm })
        continue
      }
      own.add(nm)
      parts.push({ ...part, name: `${prefix}_${nm}`, subsystem: subName })
    }
    localParts.push(own)
  }

  // --- intra-subsystem nets -------------------------------------------------
  /** @type {[string,string][]} */
  const nets = []
  const connected = new Set()
  const addNet = (a, b) => {
    nets.push([a, b])
    connected.add(refOf(a))
    connected.add(refOf(b))
  }
  for (let i = 0; i < list.length; i++) {
    const sub = list[i]
    const prefix = prefixes[i]
    const subName = sub?.name ?? `#${i}`
    const subNets = Array.isArray(sub?.nets) ? sub.nets : []
    if ((sub?.parts?.length ?? 0) > 1 && !subNets.length) {
      push('warning', 'no_nets', `subsystem "${subName}" has parts but no connections between them`, { subsystem: subName })
    }
    for (const net of subNets) {
      if (!Array.isArray(net) || net.length < 2 || !isStr(net[0]) || !isStr(net[1])) {
        push('error', 'malformed_net', `subsystem "${subName}" has a net that is not a [from, to] pair`, { subsystem: subName })
        continue
      }
      let ok = true
      for (const endpoint of [net[0], net[1]]) {
        if (!localParts[i].has(refOf(endpoint))) {
          push('error', 'unknown_ref', `subsystem "${subName}" connects "${endpoint}" but has no part "${refOf(endpoint)}"`, { subsystem: subName, ref: refOf(endpoint) })
          ok = false
        }
      }
      if (ok) addNet(nsEndpoint(prefix, net[0]), nsEndpoint(prefix, net[1]))
    }
  }

  // --- interfaces -----------------------------------------------------------
  // A `provides` is the one place a signal is produced; a `requires` is every
  // place that consumes it. One provider to many consumers is normal (a rail, a
  // shared bus). Two providers of the same signal is a design error, not a
  // merge to resolve quietly — that is exactly the class of mistake a flat
  // single-shot netlist hides.
  const providers = new Map() // signal -> { subsystem, endpoint, index }
  for (let i = 0; i < list.length; i++) {
    const sub = list[i]
    const subName = sub?.name ?? `#${i}`
    for (const port of Array.isArray(sub?.provides) ? sub.provides : []) {
      const signal = isStr(port?.signal) ? port.signal : ''
      const local = isStr(port?.net) ? port.net : ''
      if (!signal || !local) {
        push('error', 'malformed_port', `subsystem "${subName}" has a provides entry missing signal or net`, { subsystem: subName })
        continue
      }
      if (!localParts[i].has(refOf(local))) {
        push('error', 'unknown_ref', `subsystem "${subName}" provides "${signal}" from "${local}" but has no part "${refOf(local)}"`, { subsystem: subName, signal, ref: refOf(local) })
        continue
      }
      if (providers.has(signal)) {
        push('error', 'duplicate_provide', `signal "${signal}" is provided by both "${providers.get(signal).subsystem}" and "${subName}"`, { subsystem: subName, signal })
        continue
      }
      providers.set(signal, { subsystem: subName, endpoint: nsEndpoint(prefixes[i], local), index: i })
    }
  }

  const consumers = new Map() // signal -> [{subsystem, endpoint}]
  for (let i = 0; i < list.length; i++) {
    const sub = list[i]
    const subName = sub?.name ?? `#${i}`
    for (const port of Array.isArray(sub?.requires) ? sub.requires : []) {
      const signal = isStr(port?.signal) ? port.signal : ''
      const local = isStr(port?.net) ? port.net : ''
      if (!signal || !local) {
        push('error', 'malformed_port', `subsystem "${subName}" has a requires entry missing signal or net`, { subsystem: subName })
        continue
      }
      if (!localParts[i].has(refOf(local))) {
        push('error', 'unknown_ref', `subsystem "${subName}" requires "${signal}" at "${local}" but has no part "${refOf(local)}"`, { subsystem: subName, signal, ref: refOf(local) })
        continue
      }
      const provider = providers.get(signal)
      if (!provider) {
        push('error', 'unsatisfied_require', `subsystem "${subName}" requires "${signal}" but nothing provides it`, { subsystem: subName, signal })
        continue
      }
      const endpoint = nsEndpoint(prefixes[i], local)
      if (!consumers.has(signal)) consumers.set(signal, [])
      consumers.get(signal).push({ subsystem: subName, endpoint })
      addNet(provider.endpoint, endpoint)
    }
  }

  for (const [signal, provider] of providers) {
    if (!consumers.has(signal)) {
      const sev = opts.requireEveryProvideUsed ? 'error' : 'warning'
      push(sev, 'unused_provide', `signal "${signal}" from "${provider.subsystem}" is not required by any subsystem`, { subsystem: provider.subsystem, signal })
    }
  }

  /** @type {object[]} */
  const interfaces = [...providers.entries()]
    .map(([signal, provider]) => ({
      signal,
      from: provider.subsystem,
      fromEndpoint: provider.endpoint,
      to: (consumers.get(signal) ?? []).map((c) => c.subsystem),
      toEndpoints: (consumers.get(signal) ?? []).map((c) => c.endpoint),
    }))
    .sort((a, b) => a.signal.localeCompare(b.signal))

  // --- ground ---------------------------------------------------------------
  // Ground is the one net every subsystem shares by definition, so it is merged
  // rather than routed through the provides/requires contract.
  const gnd = []
  for (let i = 0; i < list.length; i++) {
    for (const ref of Array.isArray(list[i]?.gnd) ? list[i].gnd : []) {
      if (!isStr(ref)) continue
      if (!localParts[i].has(refOf(ref))) {
        push('error', 'unknown_ref', `subsystem "${list[i]?.name}" grounds "${ref}" but has no part "${refOf(ref)}"`, { subsystem: list[i]?.name, ref: refOf(ref) })
        continue
      }
      gnd.push(nsEndpoint(prefixes[i], ref))
      connected.add(refOf(nsEndpoint(prefixes[i], ref)))
    }
  }

  // --- orphans --------------------------------------------------------------
  for (const part of parts) {
    if (!connected.has(part.name)) {
      push('warning', 'orphan_part', `"${part.name}" (${part.subsystem}) has no connections at all`, { subsystem: part.subsystem, ref: part.name })
    }
  }

  return {
    parts,
    nets,
    gnd,
    interfaces,
    problems,
    stats: {
      subsystems: list.length,
      parts: parts.length,
      nets: nets.length,
      interfaces: interfaces.length,
      errors: problems.filter((p) => p.severity === 'error').length,
      warnings: problems.filter((p) => p.severity === 'warning').length,
    },
  }
}

/**
 * Re-check an already-composed result. `composeSubsystems` folds these in, but
 * a caller that has stored or transported a composition can revalidate it
 * without recomposing.
 */
export function verifyComposition(result) {
  const problems = Array.isArray(result?.problems) ? [...result.problems] : []
  const names = new Set((result?.parts ?? []).map((p) => p?.name))
  for (const net of result?.nets ?? []) {
    for (const endpoint of net ?? []) {
      const ref = refOf(endpoint)
      if (!names.has(ref)) {
        problems.push({ severity: 'error', code: 'unknown_ref', message: `composed net references "${endpoint}" but there is no part "${ref}"`, ref })
      }
    }
  }
  for (const iface of result?.interfaces ?? []) {
    if (!iface?.to?.length) {
      problems.push({ severity: 'warning', code: 'unused_provide', message: `signal "${iface?.signal}" reaches no consumer`, signal: iface?.signal })
    }
  }
  return problems
}

/**
 * Turn a high-level plan into the per-subsystem generation briefs a caller
 * hands to N independent design calls. Pure data shaping — the whole point is
 * that each brief is self-contained, so the calls can run in parallel and each
 * one only has to be right about its own subsystem plus the contract it must
 * meet at the edges.
 */
export function splitForGeneration(plan) {
  const subs = Array.isArray(plan?.subsystems) ? plan.subsystems : []
  return subs.map((sub) => ({
    name: sub?.name ?? '',
    purpose: sub?.purpose ?? '',
    // Everything this subsystem must expose, and everything it may assume
    // exists. A generator that satisfies exactly this contract composes
    // cleanly with its siblings without ever seeing them.
    mustProvide: (Array.isArray(sub?.provides) ? sub.provides : []).map((p) => p?.signal).filter(isStr),
    mayRequire: (Array.isArray(sub?.requires) ? sub.requires : []).map((p) => p?.signal).filter(isStr),
    contract:
      `Design ONLY the "${sub?.name}" subsystem. ` +
      `Expose these signals: ${(sub?.provides ?? []).map((p) => p?.signal).filter(isStr).join(', ') || '(none)'}. ` +
      `You may assume these already exist: ${(sub?.requires ?? []).map((p) => p?.signal).filter(isStr).join(', ') || '(none)'}. ` +
      `Use local reference designators (U1, C1, R1); they are namespaced on composition.`,
  }))
}
