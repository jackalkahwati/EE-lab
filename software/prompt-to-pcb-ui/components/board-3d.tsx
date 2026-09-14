'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCcw, ArrowUp, ArrowDown } from 'lucide-react'
import type { Material, Mesh, Object3D, Texture } from 'three'

/** Effect-local ownership, including objects delivered after cleanup by GLTFLoader. */
export function createViewerLifetime() {
  const abort = new AbortController()
  const releases: Array<() => void> = []
  const resources = new Set<{ dispose: () => void }>()
  let disposed = false
  const defer = (release: () => void) => {
    if (disposed) release()
    else releases.push(release)
  }
  const own = <T extends { dispose: () => void }>(resource: T): T => {
    if (!resources.has(resource)) {
      resources.add(resource)
      defer(() => resource.dispose())
    }
    return resource
  }
  const trackMaterial = (material: Material) => {
    for (const value of Object.values(material)) {
      if (value && typeof value === 'object' && (value as Texture).isTexture) own(value as Texture)
    }
    own(material)
  }
  const trackObject = (root: Object3D) => root.traverse((object) => {
    const renderable = object as Mesh
    if (renderable.geometry) own(renderable.geometry)
    if (renderable.material) {
      const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material]
      materials.forEach(trackMaterial)
    }
    // LightShadow owns render targets that are not materials or mesh geometry.
    const light = object as Object3D & { shadow?: { dispose: () => void } }
    if (light.shadow) own(light.shadow)
  })
  return {
    abort, defer, own, trackObject,
    get disposed() { return disposed },
    dispose() {
      if (disposed) return
      disposed = true
      abort.abort()
      // A teardown failure must not strand the remaining canvas/GPU resources.
      for (const release of releases.splice(0).reverse()) {
        try { release() } catch { /* continue releasing independently owned resources */ }
      }
    },
  }
}

/**
 * Full 3D PCBA review: loads the run's board as a GLB (exported on demand from
 * variant.kicad_pcb by /api/board3d) into a three.js scene with orbit
 * controls — drag to rotate, scroll to zoom, right-drag / two-finger drag to
 * pan. `fallback` is terminal error content, never a loading placeholder.
 * Callers may provide saved imagery or an explicit unavailable state.
 */

type Phase = 'loading' | 'ready' | 'error'

// imperative viewer API handed back from the setup effect
interface ViewerApi {
  setSide: (side: 'top' | 'bottom') => void
  reset: () => void
  dispose: () => void
}

/** Saved native mode never invokes an exporter or accepts a general-purpose URL. */
export function nativeBoardGlbUrl(value: string): string {
  if (!/^\/runs\/run-[A-Za-z0-9._-]{1,124}\/board\/chipscale\.glb(?:\?v=[a-f0-9]{64})?$/.test(value)) {
    throw new Error('Invalid saved native model URL.')
  }
  return value
}

/** GLB dependencies must be embedded, never another HTTP request or file path. */
export function nativeBoardResourceUrl(value: string): string {
  if (/^blob:/.test(value) && value.length <= 2048) return value
  if (value.length <= 24 * 1024 * 1024 && /^data:(?:image\/(?:png|jpeg)|application\/octet-stream);base64,[A-Za-z0-9+/]*={0,2}$/.test(value)) return value
  throw new Error('Saved native model contains a non-embedded resource.')
}

export function Board3D({ basePath, fallback, glbUrl }: { basePath: string; fallback: ReactNode; glbUrl?: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<ViewerApi | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    const lifetime = createViewerLifetime()
    const mount = mountRef.current
    const stale = () => lifetime.disposed || !mount || mountRef.current !== mount
    let viewerApi: ViewerApi | null = null
    lifetime.defer(() => { if (apiRef.current === viewerApi) apiRef.current = null })
    setPhase('loading')
    setError('')

    ;(async () => {
      const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/controls/OrbitControls.js'),
      ])

      if (stale() || !mount) return
      const savedNative = glbUrl !== undefined
      const url = savedNative ? nativeBoardGlbUrl(glbUrl) : `/api/board3d?base=${encodeURIComponent(basePath)}`
      const res = await fetch(url, { signal: lifetime.abort.signal, ...(savedNative ? { cache: 'no-store' as const, redirect: 'error' as const } : {}) })
      if (stale()) return
      if (!res.ok) {
        const msg = await res
          .json()
          .then((j) => j.error)
          .catch(() => `HTTP ${res.status}`)
        if (stale()) return
        throw new Error(msg)
      }
      const buf = await res.arrayBuffer()
      if (stale()) return

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x0a0a0a)

      lifetime.defer(() => lifetime.trackObject(scene))
      const manager = savedNative ? new THREE.LoadingManager().setURLModifier(nativeBoardResourceUrl) : undefined
      const gltf = await new GLTFLoader(manager).parseAsync(buf, '')
      // Parsing cannot be aborted; claim late resources before rejecting the result.
      gltf.scenes.forEach(lifetime.trackObject)
      if (stale()) return
      scene.add(gltf.scene)

      // frame the board: KiCad GLBs are Y-up, board thickness along Y
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const span = Math.max(size.x, size.z) || 0.02

      const camera = new THREE.PerspectiveCamera(
        40,
        mount.clientWidth / Math.max(1, mount.clientHeight),
        span / 100,
        span * 40,
      )

      const renderer = lifetime.own(new THREE.WebGLRenderer({ antialias: true }))
      lifetime.defer(() => renderer.domElement.remove())
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 0.92
      renderer.outputColorSpace = THREE.SRGBColorSpace
      mount.appendChild(renderer.domElement)

      // image-based lighting → glossy highlights, but keep it subtle so it
      // doesn't wash the soldermask out
      try {
        const { RoomEnvironment } = await import(
          'three/examples/jsm/environments/RoomEnvironment.js')
        if (stale()) return
        const pmrem = new THREE.PMREMGenerator(renderer)
        const room = new RoomEnvironment()
        try {
          const environment = lifetime.own(pmrem.fromScene(room, 0.04))
          scene.environment = environment.texture
          lifetime.defer(() => { scene.environment = null })
          scene.environmentIntensity = 0.4
        } finally {
          room.dispose()
          pmrem.dispose()
        }
      } catch { /* analytic lights alone still render fine */ }
      if (stale()) return

      // real geometry casts + receives shadows; darken + saturate the soldermask
      // (KiCad greens render pale) so the board reads as a rich dark green
      gltf.scene.traverse((object) => {
        const o = object as Mesh
        if (!o.isMesh) return
        o.castShadow = true
        o.receiveShadow = true
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((material) => {
          const mm = material as import('three').MeshStandardMaterial
          const c = mm.color
          if (!c) return
          if (c.g > c.r * 1.06 && c.g > c.b * 1.06) { // greenish → soldermask
            const hsl = { h: 0, s: 0, l: 0 }
            c.getHSL(hsl)
            c.setHSL(hsl.h, Math.min(1, hsl.s * 1.6), hsl.l * 0.38)
            if ('roughness' in mm) mm.roughness = Math.min(1, (mm.roughness ?? 0.5) + 0.1)
          }
        })
      })

      scene.add(new THREE.AmbientLight(0xffffff, 0.22))
      const key = new THREE.DirectionalLight(0xffffff, 2.9)
      key.position.set(center.x + span * 0.5, center.y + span * 1.4, center.z + span * 0.7)
      key.target.position.copy(center)
      key.castShadow = true
      key.shadow.mapSize.set(2048, 2048)
      key.shadow.bias = -0.0004
      const sc = key.shadow.camera
      const d = span * 0.8
      sc.left = -d; sc.right = d; sc.top = d; sc.bottom = -d
      sc.near = span * 0.05; sc.far = span * 8
      sc.updateProjectionMatrix()
      scene.add(key, key.target)
      const fill = new THREE.DirectionalLight(0xbfd4ff, 0.55)
      fill.position.set(center.x - span, center.y + span * 0.4, center.z - span)
      scene.add(fill)

      // soft contact shadow on a faint stage floor
      const floorY = box.min.y - span * 0.012
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(span * 8, span * 8),
        new THREE.ShadowMaterial({ opacity: 0.4 }))
      ground.rotation.x = -Math.PI / 2
      ground.position.set(center.x, floorY, center.z)
      ground.receiveShadow = true
      scene.add(ground)
      const grid = new THREE.GridHelper(span * 8, 32, 0x1b2530, 0x0f141b)
      grid.position.set(center.x, floorY, center.z)
      scene.add(grid)

      const controls = lifetime.own(new OrbitControls(camera, renderer.domElement))
      controls.target.copy(center)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.minDistance = span * 0.05
      controls.maxDistance = span * 6

      // front-facing hero: the component side square to the camera, tilted ~30°
      // for depth. Distance fits the board's bounding sphere to the FOV so any
      // board size frames the same way.
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      const fitDist = sphere.radius / Math.sin((camera.fov / 2) * Math.PI / 180) * 1.15
      const goto = (side: 'top' | 'bottom') => {
        const dir = side === 'top' ? 1 : -1
        const theta = (30 * Math.PI) / 180 // tilt from straight-on
        camera.position.set(
          center.x,
          center.y + dir * fitDist * Math.cos(theta),
          center.z + fitDist * Math.sin(theta),
        )
        camera.up.set(0, dir, 0)
        controls.target.copy(center)
        controls.update()
      }
      goto('top')

      let raf = 0
      lifetime.defer(() => cancelAnimationFrame(raf))
      const loop = () => {
        if (stale()) return
        raf = requestAnimationFrame(loop)
        controls.update()
        renderer.render(scene, camera)
      }
      loop()

      const onResize = () => {
        if (stale()) return
        const w = mount.clientWidth
        const h = mount.clientHeight
        if (!w || !h) return
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h)
      }
      const ro = new ResizeObserver(onResize)
      lifetime.defer(() => ro.disconnect())
      ro.observe(mount)
      onResize()

      viewerApi = {
        setSide: (side) => goto(side),
        reset: () => goto('top'),
        dispose: () => lifetime.dispose(),
      }
      apiRef.current = viewerApi
      setPhase('ready')
    })().catch((e: unknown) => {
      if (!stale()) {
        setError(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
      lifetime.dispose()
    })

    return () => lifetime.dispose()
  }, [basePath, glbUrl])

  return (
    <div data-viewer="board" data-viewer-phase={phase} className="relative h-full w-full overflow-hidden">
      <div ref={mountRef} className="h-full w-full" />

      {phase === 'error' && (
        <div className="absolute inset-0 flex flex-col bg-[#0a0a0a]">
          <div role="alert" className="border-b border-border bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-500/90">
            3D model unavailable ({error})
          </div>
          <div className="min-h-0 flex-1">{fallback}</div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0a0a0a]">
          <div className="size-5 animate-spin rounded-full border-2 border-border border-t-primary" />
          <p className="font-mono text-[10px] text-muted-foreground">
            {glbUrl !== undefined ? 'Loading saved native 3D model…' : 'building 3D model from variant.kicad_pcb… first open takes ~10 s'}
          </p>
        </div>
      )}

      {phase === 'ready' && (
        <>
          <div className="absolute right-3 top-3 flex items-center gap-1">
            {[
              { label: 'Top side', icon: ArrowUp, act: () => apiRef.current?.setSide('top') },
              { label: 'Bottom side', icon: ArrowDown, act: () => apiRef.current?.setSide('bottom') },
              { label: 'Reset view', icon: RotateCcw, act: () => apiRef.current?.reset() },
            ].map(({ label, icon: I, act }) => (
              <button
                key={label}
                type="button"
                aria-label={label}
                title={label}
                onClick={act}
                className="rounded-sm border border-border bg-secondary/90 p-1.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <I className="size-3.5" />
              </button>
            ))}
          </div>
          <span className="pointer-events-none absolute bottom-2 right-3 font-mono text-[9px] text-muted-foreground/60">
            drag to rotate · scroll to zoom · right-drag to pan
          </span>
        </>
      )}
    </div>
  )
}
