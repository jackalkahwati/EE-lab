//! flroute — FirstLight PCB autorouter (v1).
//!
//! Drop-in for freerouting in the FL-1 pipeline: reads a KiCad-exported
//! Specctra DSN, routes the signal nets, and emits a Specctra SES that
//! `pcbnew.ImportSpecctraSES` accepts. Zone-served nets (GND / coil
//! rail) are skipped — the pours own them, same as the freerouting flow.
//!
//! v1 pipeline: fanout escape stubs for fine-pitch pads -> PathFinder
//! negotiated congestion (split track/ring/center model) -> hard
//! consolidation ordered by pin-pocket tightness -> transactional
//! rip-and-swap with iterative deepening -> emission gate with
//! pad-shape-aware terminal snapping. 174/174 on Rev A (~170 s).
//! Validated differentially against freerouting + KiCad DRC.

use std::collections::{BinaryHeap, HashMap, HashSet};
use std::env;
use std::fs;
use std::time::Instant;

// ---------- s-expression parsing -------------------------------------------

#[derive(Debug, Clone)]
enum Sx {
    Sym(String),
    List(Vec<Sx>),
}

impl Sx {
    fn sym(&self) -> &str {
        match self {
            Sx::Sym(s) => s,
            _ => "",
        }
    }
    fn list(&self) -> &[Sx] {
        match self {
            Sx::List(v) => v,
            _ => &[],
        }
    }
    fn tag(&self) -> &str {
        self.list().first().map(|s| s.sym()).unwrap_or("")
    }
    fn kids<'a>(&'a self, tag: &'a str) -> impl Iterator<Item = &'a Sx> + 'a {
        self.list().iter().filter(move |k| k.tag() == tag)
    }
    fn kid<'a>(&'a self, tag: &'a str) -> Option<&'a Sx> {
        self.kids(tag).next()
    }
    fn num(&self, i: usize) -> f64 {
        self.list()
            .get(i)
            .and_then(|s| s.sym().parse().ok())
            .unwrap_or(0.0)
    }
}

fn parse_sx(text: &str) -> Sx {
    let b = text.as_bytes();
    let mut i = 0usize;
    fn skip_ws(b: &[u8], i: &mut usize) {
        while *i < b.len() && (b[*i] as char).is_whitespace() {
            *i += 1;
        }
    }
    fn parse_node(b: &[u8], i: &mut usize) -> Sx {
        skip_ws(b, i);
        if b[*i] == b'(' {
            *i += 1;
            let mut items = Vec::new();
            loop {
                skip_ws(b, i);
                if *i >= b.len() || b[*i] == b')' {
                    *i += 1;
                    break;
                }
                items.push(parse_node(b, i));
            }
            Sx::List(items)
        } else if b[*i] == b'"' {
            *i += 1;
            let start = *i;
            while *i < b.len() && b[*i] != b'"' {
                *i += 1;
            }
            let s = String::from_utf8_lossy(&b[start..*i]).into_owned();
            *i += 1;
            Sx::Sym(s)
        } else {
            let start = *i;
            while *i < b.len()
                && !(b[*i] as char).is_whitespace()
                && b[*i] != b'('
                && b[*i] != b')'
            {
                *i += 1;
            }
            Sx::Sym(String::from_utf8_lossy(&b[start..*i]).into_owned())
        }
    }
    parse_node(b, &mut i)
}

// ---------- board model ------------------------------------------------------

#[derive(Clone)]
struct Pin {
    padstack: String,
    id: String,
    x: f64,
    y: f64,
    rot: f64,
}

struct Image {
    pins: Vec<Pin>,
}

#[derive(Clone)]
struct PadInfo {
    hw: f64, // half-extent x (dsn units)
    hh: f64, // half-extent y
    ox: f64, // shape center offset from pin origin
    oy: f64,
    layers: u8,   // bitmask; 0xFF = all layers (THT)
    circle: bool, // round pad: corners of the bbox hold no copper
}

struct AbsPin {
    x: f64,
    y: f64,
    pad: PadInfo,
}

struct Net {
    name: String,
    pins: Vec<String>,
}

struct Routed {
    name: String,
    paths: Vec<(usize, Vec<(usize, usize)>)>, // (layer, cells)
    vias: Vec<(usize, usize)>,
}

static ATTEMPTED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: flroute <in.dsn> <out.ses> [--skip-net NAME]...");
        std::process::exit(2);
    }
    let t0 = Instant::now();
    let text = fs::read_to_string(&args[1]).expect("read dsn");
    let root = parse_sx(&text);
    let design_name = root
        .list()
        .get(1)
        .map(|s| s.sym().to_string())
        .unwrap_or_default();

    let resolution = root
        .kid("resolution")
        .map(|r| r.num(2))
        .filter(|v| *v > 0.0)
        .unwrap_or(10.0);
    let mm = |v: f64| v * 1000.0; // DSN coords are plain um

    let structure = root.kid("structure").expect("structure");
    let layers: Vec<String> = structure
        .kids("layer")
        .map(|l| l.list()[1].sym().to_string())
        .collect();
    let nl = layers.len().max(1);

    // boundary bbox
    let (mut bx0, mut by0, mut bx1, mut by1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    if let Some(path) = structure.kid("boundary").and_then(|b| b.kid("path")) {
        for pair in path.list()[3..].chunks(2) {
            if pair.len() == 2 {
                let x: f64 = pair[0].sym().parse().unwrap_or(0.0);
                let y: f64 = pair[1].sym().parse().unwrap_or(0.0);
                bx0 = bx0.min(x);
                by0 = by0.min(y);
                bx1 = bx1.max(x);
                by1 = by1.max(y);
            }
        }
    }

    // rules
    let mut width = mm(0.25);
    let mut clearance = mm(0.2);
    if let Some(rule) = structure.kid("rule") {
        if let Some(w) = rule.kid("width") {
            width = w.num(1);
        }
        for c in rule.kids("clearance") {
            if c.list().len() == 2 {
                clearance = c.num(1);
            }
        }
    }
    let via_name = structure
        .kid("via")
        .and_then(|v| v.list().get(1))
        .map(|s| s.sym().to_string())
        .unwrap_or_else(|| "Via[0-1]_800:400_um".to_string());

    // ---------- library ------------------------------------------------------
    let lib = root.kid("library").expect("library");
    let mut padstacks: HashMap<String, PadInfo> = HashMap::new();
    for ps in lib.kids("padstack") {
        let name = ps.list()[1].sym().to_string();
        let (mut hw, mut hh, mut ox, mut oy) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let mut mask: u8 = 0;
        let mut any_unknown_layer = false;
        let mut all_circle = true;
        for sh in ps.kids("shape") {
            let inner = &sh.list()[1];
            let kind = inner.tag();
            let lname = inner.list().get(1).map(|s| s.sym()).unwrap_or("");
            match layers.iter().position(|l| l == lname) {
                Some(i) => mask |= 1 << i,
                None => any_unknown_layer = true,
            }
            let vals: Vec<f64> = inner.list()[2..]
                .iter()
                .filter_map(|s| s.sym().parse().ok())
                .collect();
            if kind != "circle" {
                all_circle = false;
            }
            let (shw, shh, sox, soy) = match kind {
                "circle" => {
                    let r = vals.first().copied().unwrap_or(0.0) / 2.0;
                    (r, r, 0.0, 0.0)
                }
                "rect" => {
                    if vals.len() >= 4 {
                        (
                            (vals[2] - vals[0]).abs() / 2.0,
                            (vals[3] - vals[1]).abs() / 2.0,
                            (vals[0] + vals[2]) / 2.0,
                            (vals[1] + vals[3]) / 2.0,
                        )
                    } else {
                        (0.0, 0.0, 0.0, 0.0)
                    }
                }
                "path" | "polygon" => {
                    let w = vals.first().copied().unwrap_or(0.0);
                    let xs: Vec<f64> = vals[1..].iter().step_by(2).cloned().collect();
                    let ys: Vec<f64> = vals[2..].iter().step_by(2).cloned().collect();
                    if xs.is_empty() || ys.is_empty() {
                        (w / 2.0, w / 2.0, 0.0, 0.0)
                    } else {
                        let (x0, x1) = (
                            xs.iter().cloned().fold(f64::MAX, f64::min),
                            xs.iter().cloned().fold(f64::MIN, f64::max),
                        );
                        let (y0, y1) = (
                            ys.iter().cloned().fold(f64::MAX, f64::min),
                            ys.iter().cloned().fold(f64::MIN, f64::max),
                        );
                        (
                            (x1 - x0) / 2.0 + w / 2.0,
                            (y1 - y0) / 2.0 + w / 2.0,
                            (x0 + x1) / 2.0,
                            (y0 + y1) / 2.0,
                        )
                    }
                }
                _ => (0.0, 0.0, 0.0, 0.0),
            };
            if shw > hw {
                hw = shw;
                ox = sox;
            }
            if shh > hh {
                hh = shh;
                oy = soy;
            }
        }
        if mask == 0 || any_unknown_layer {
            mask = 0xFF;
        }
        padstacks.insert(name, PadInfo { hw, hh, ox, oy, layers: mask, circle: all_circle });
    }

    let mut images: HashMap<String, Image> = HashMap::new();
    for im in lib.kids("image") {
        let name = im.list()[1].sym().to_string();
        let mut pins = Vec::new();
        for p in im.kids("pin") {
            let l = p.list();
            let mut idx = 1;
            let padstack = l[idx].sym().to_string();
            idx += 1;
            let mut prot = 0.0f64;
            if let Some(Sx::List(rl)) = l.get(idx) {
                if rl.first().map(|s| s.sym()) == Some("rotate") {
                    prot = rl.get(1).and_then(|s| s.sym().parse().ok()).unwrap_or(0.0);
                    idx += 1;
                }
            }
            if l.len() < idx + 3 {
                continue;
            }
            let id = l[idx].sym().to_string();
            let x: f64 = l[idx + 1].sym().parse().unwrap_or(0.0);
            let y: f64 = l[idx + 2].sym().parse().unwrap_or(0.0);
            pins.push(Pin { padstack, id, x, y, rot: prot });
        }
        images.insert(name, Image { pins });
    }

    // ---------- placement -> absolute pins -----------------------------------
    let mut abs_pins: HashMap<String, AbsPin> = HashMap::new();
    let placement = root.kid("placement").expect("placement");
    for comp in placement.kids("component") {
        let img_name = comp.list()[1].sym();
        let img = match images.get(img_name) {
            Some(i) => i,
            None => continue,
        };
        for pl in comp.kids("place") {
            let l = pl.list();
            if l.len() < 5 {
                continue;
            }
            let r = l[1].sym().to_string();
            let cx: f64 = l[2].sym().parse().unwrap_or(0.0);
            let cy: f64 = l[3].sym().parse().unwrap_or(0.0);
            let side = l[4].sym().to_string();
            let crot: f64 = l
                .get(5)
                .and_then(|s| s.sym().parse().ok())
                .unwrap_or(0.0);
            let a = crot.to_radians();
            for pin in &img.pins {
                let (mut px, py) = (pin.x, pin.y);
                if side == "back" {
                    px = -px;
                }
                let (s, c) = a.sin_cos();
                let rx = px * c - py * s;
                let ry = px * s + py * c;
                let mut pad = padstacks
                    .get(&pin.padstack)
                    .cloned()
                    .unwrap_or(PadInfo {
                        hw: mm(0.5),
                        hh: mm(0.5),
                        ox: 0.0,
                        oy: 0.0,
                        layers: 0xFF,
                        circle: false,
                    });
                // rotate the pad's bbox with the component + pin rotation
                {
                    let at = a + pin.rot.to_radians();
                    let (sa, ca) = at.sin_cos();
                    let nhw = (pad.hw * ca).abs() + (pad.hh * sa).abs();
                    let nhh = (pad.hw * sa).abs() + (pad.hh * ca).abs();
                    let nox = pad.ox * ca - pad.oy * sa;
                    let noy = pad.ox * sa + pad.oy * ca;
                    pad.hw = nhw;
                    pad.hh = nhh;
                    pad.ox = nox;
                    pad.oy = noy;
                }
                if side == "back" && pad.layers != 0xFF {
                    let mut m = 0u8;
                    for i in 0..nl {
                        if pad.layers & (1 << i) != 0 {
                            m |= 1 << (nl - 1 - i);
                        }
                    }
                    pad.layers = m;
                }
                abs_pins.insert(
                    format!("{}-{}", r, pin.id),
                    AbsPin {
                        x: cx + rx,
                        y: cy + ry,
                        pad,
                    },
                );
            }
        }
    }

    // ---------- nets -----------------------------------------------------------
    let network = root.kid("network").expect("network");
    let skip_extra: Vec<String> = args
        .windows(2)
        .filter(|w| w[0] == "--skip-net")
        .map(|w| w[1].clone())
        .collect();
    let mut nets: Vec<Net> = Vec::new();
    for n in network.kids("net") {
        let name = n.list()[1].sym().to_string();
        let pins: Vec<String> = n
            .kid("pins")
            .map(|p| p.list()[1..].iter().map(|s| s.sym().to_string()).collect())
            .unwrap_or_default();
        nets.push(Net { name, pins });
    }
    // zone-served nets: the two largest by pin count, plus any --skip-net
    let mut by_size: Vec<usize> = (0..nets.len()).collect();
    by_size.sort_by(|&a, &b| nets[b].pins.len().cmp(&nets[a].pins.len()));
    let mut skip: HashSet<String> = by_size
        .iter()
        .take(2)
        .map(|&i| nets[i].name.clone())
        .collect();
    skip.extend(skip_extra);
    eprintln!("zone-served (skipped): {:?}", skip);

    // ---------- grid --------------------------------------------------------------
    let pitch = (width + clearance) * 1.15; // grid >= rule-safe track spacing
    let gw = ((bx1 - bx0) / pitch).ceil() as usize + 2;
    let gh = ((by1 - by0) / pitch).ceil() as usize + 2;
    let ncell = gw * gh * nl;
    eprintln!(
        "grid {}x{}x{} = {} cells (pitch {:.2}mm), layers {:?}",
        gw, gh, nl, ncell, pitch / 1000.0, layers
    );
    let mut owner: Vec<u16> = vec![0; ncell];
    let idx = |x: usize, y: usize, l: usize| (l * gh + y) * gw + x;
    let to_cell = |x: f64, y: f64| -> (usize, usize) {
        (
            (((x - bx0) / pitch).round() as isize).clamp(0, gw as isize - 1) as usize,
            (((y - by0) / pitch).round() as isize).clamp(0, gh as isize - 1) as usize,
        )
    };

    let halo = clearance + width / 2.0 + mm(0.05); // guard band vs float-exact ties
    let mut net_id_of: HashMap<String, u16> = HashMap::new();
    for (i, n) in nets.iter().enumerate() {
        net_id_of.insert(n.name.clone(), (i + 1) as u16);
    }
    let mut pin_net: HashMap<String, u16> = HashMap::new();
    for n in &nets {
        let id = net_id_of[&n.name];
        for p in &n.pins {
            pin_net.insert(p.clone(), id);
        }
    }
    for (pname, ap) in &abs_pins {
        let nid = pin_net.get(pname).copied().unwrap_or(u16::MAX);
        let rx = ap.pad.hw + halo;
        let ry = ap.pad.hh + halo;
        let pcx = ap.x + ap.pad.ox; // true pad center (world)
        let pcy = ap.y + ap.pad.oy;
        let x_lo = (((pcx - rx - bx0) / pitch).floor() as isize).max(0);
        let x_hi = (((pcx + rx - bx0) / pitch).ceil() as isize).min(gw as isize - 1);
        let y_lo = (((pcy - ry - by0) / pitch).floor() as isize).max(0);
        let y_hi = (((pcy + ry - by0) / pitch).ceil() as isize).min(gh as isize - 1);
        for y in y_lo..=y_hi {
            for x in x_lo..=x_hi {
                // copper laid at this cell center must clear the true pad box
                let ddx = (bx0 + x as f64 * pitch) - pcx;
                let ddy = (by0 + y as f64 * pitch) - pcy;
                if ddx.abs() > rx || ddy.abs() > ry {
                    continue;
                }
                for l in 0..nl {
                    if ap.pad.layers & (1 << l) == 0 {
                        continue;
                    }
                    let c = &mut owner[idx(x as usize, y as usize, l)];
                    if *c == 0 {
                        *c = nid;
                    } else if *c != nid {
                        *c = u16::MAX;
                    }
                }
            }
        }
    }

    // ---------- fanout stubs for fine-pitch pads -----------------------------------
    // At cell granularity a fine-pitch pad can be walled in by neighbor pads'
    // clearance halos even though a straight outward escape lane is DRC-legal
    // in exact geometry. Emit an exact-coordinate stub wire from the pad to the
    // first free cell (legality checked against true pad boxes, not the grid)
    // and let the grid router continue from the stub end.
    let mut comp_sum: HashMap<String, (f64, f64, u32)> = HashMap::new();
    for (k, ap) in &abs_pins {
        let comp = k.rsplit_once('-').map(|(c, _)| c).unwrap_or(k.as_str());
        let e = comp_sum.entry(comp.to_string()).or_insert((0.0, 0.0, 0));
        e.0 += ap.x + ap.pad.ox;
        e.1 += ap.y + ap.pad.oy;
        e.2 += 1;
    }
    let mut stub_wires: HashMap<String, Vec<(usize, Vec<(f64, f64)>)>> = HashMap::new();
    let mut stub_end: HashMap<String, usize> = HashMap::new();
    let lane = clearance + width / 2.0; // min line-to-foreign-copper distance
    let mut stub_count = 0usize;
    // iterate to fixpoint: a stub corridor can wall in a neighboring pad,
    // which then needs its own stub in the next round
    for _round in 0..3 {
    // free-space connected components per layer; a pin "escapes" only if it
    // reaches the MAIN field (radius tests miss large sealed pockets, e.g.
    // under-body channels of an SOIC)
    let mut comp_label: Vec<Vec<u32>> = Vec::new();
    let mut comp_main: Vec<u32> = Vec::new();
    for l in 0..nl {
        let mut lab = vec![0u32; gw * gh];
        let mut next = 0u32;
        let mut best = (0u32, 0usize);
        for start in 0..gw * gh {
            if lab[start] != 0 || owner[idx(start % gw, start / gw, l)] != 0 {
                continue;
            }
            next += 1;
            let mut size = 0usize;
            let mut st = vec![start];
            lab[start] = next;
            while let Some(c) = st.pop() {
                size += 1;
                let (x, y) = (c % gw, c / gw);
                for (nx, ny) in [
                    (x.wrapping_sub(1), y),
                    (x + 1, y),
                    (x, y.wrapping_sub(1)),
                    (x, y + 1),
                ] {
                    if nx < gw && ny < gh {
                        let n2 = ny * gw + nx;
                        if lab[n2] == 0 && owner[idx(nx, ny, l)] == 0 {
                            lab[n2] = next;
                            st.push(n2);
                        }
                    }
                }
            }
            if size > best.1 {
                best = (next, size);
            }
        }
        comp_label.push(lab);
        comp_main.push(best.0);
    }
    let mut new_stubs = 0usize;
    for (pname, ap) in &abs_pins {
        if stub_end.contains_key(pname) {
            continue;
        }
        let nid = match pin_net.get(pname) {
            Some(&n) if n != u16::MAX => n,
            _ => continue,
        };
        if skip.contains(&nets[(nid - 1) as usize].name) {
            continue; // zone-served nets don't need escapes
        }
        if ap.pad.layers == 0xFF {
            continue; // THT pads escape on some layer
        }
        let comp = pname.rsplit_once('-').map(|(c, _)| c).unwrap_or(pname);
        let l0 = match (0..nl).find(|&l| ap.pad.layers & (1 << l) != 0) {
            Some(l) => l,
            None => continue,
        };
        let pcx = ap.x + ap.pad.ox;
        let pcy = ap.y + ap.pad.oy;
        let rx = ap.pad.hw + width / 2.0;
        let ry = ap.pad.hh + width / 2.0;
        // on-copper cells = BFS seeds
        let mut seeds: Vec<(usize, usize)> = Vec::new();
        {
            let x_lo = (((pcx - rx - bx0) / pitch).floor() as isize).max(0);
            let x_hi = (((pcx + rx - bx0) / pitch).ceil() as isize).min(gw as isize - 1);
            let y_lo = (((pcy - ry - by0) / pitch).floor() as isize).max(0);
            let y_hi = (((pcy + ry - by0) / pitch).ceil() as isize).min(gh as isize - 1);
            for y in y_lo..=y_hi {
                for x in x_lo..=x_hi {
                    let ddx = (bx0 + x as f64 * pitch) - pcx;
                    let ddy = (by0 + y as f64 * pitch) - pcy;
                    let hit = if ap.pad.circle { (ddx * ddx + ddy * ddy).sqrt() <= rx.min(ry) } else { ddx.abs() <= rx && ddy.abs() <= ry };
                    if hit {
                        seeds.push((x as usize, y as usize));
                    }
                }
            }
        }
        let (pcxc, pcyc) = to_cell(pcx, pcy);
        if seeds.is_empty() {
            seeds.push((pcxc, pcyc));
        }
        // walled test: can a path of free/own cells get 3+ cells away?
        let mut seen: HashSet<(usize, usize)> = HashSet::new();
        let mut q: std::collections::VecDeque<(usize, usize)> = seeds
            .iter()
            .filter(|&&(x, y)| {
                let o = owner[idx(x, y, l0)];
                o == 0 || o == nid
            })
            .cloned()
            .collect();
        seen.extend(q.iter().cloned());
        let mut escape = false;
        let mut visited = 0usize;
        while let Some((x, y)) = q.pop_front() {
            visited += 1;
            if visited > 1500 {
                escape = true; // live reachability: a large region is escapable
                break;
            }
            for (nx, ny) in [
                (x.wrapping_sub(1), y),
                (x + 1, y),
                (x, y.wrapping_sub(1)),
                (x, y + 1),
            ] {
                if nx < gw && ny < gh && !seen.contains(&(nx, ny)) {
                    let o = owner[idx(nx, ny, l0)];
                    if o == 0 || o == nid {
                        seen.insert((nx, ny));
                        q.push_back((nx, ny));
                    }
                }
            }
        }
        if escape {
            continue;
        }
        // try a straight stub, away from the component body first
        let (sx, sy, scnt) = comp_sum[comp];
        let (dx, dy) = (pcx - sx / scnt as f64, pcy - sy / scnt as f64);
        let dirs: [(f64, f64); 4] = if dx.abs() >= dy.abs() {
            [
                (dx.signum(), 0.0),
                (0.0, dy.signum()),
                (0.0, -dy.signum()),
                (-dx.signum(), 0.0),
            ]
        } else {
            [
                (0.0, dy.signum()),
                (dx.signum(), 0.0),
                (-dx.signum(), 0.0),
                (0.0, -dy.signum()),
            ]
        };
        let mut placed = false;
        'dirs: for (ux, uy) in dirs {
            for k in 2..=12usize {
                let tx = pcx + ux * k as f64 * (pitch / 2.0);
                let ty = pcy + uy * k as f64 * (pitch / 2.0);
                let (cxe, cye) = to_cell(tx, ty);
                // the stub must END in the main field, not another pocket
                if owner[idx(cxe, cye, l0)] != 0
                    || comp_label[l0][cye * gw + cxe] != comp_main[l0]
                {
                    continue;
                }
                // snap the end to the cell center so the router continues there
                let ex = bx0 + cxe as f64 * pitch;
                let ey = by0 + cye as f64 * pitch;
                let len2 = (ex - pcx) * (ex - pcx) + (ey - pcy) * (ey - pcy);
                if len2 < 1.0 {
                    continue;
                }
                // exact legality: stub line vs every nearby foreign pad box
                let reach = lane + 4000.0;
                let mut legal = true;
                for (qk, qp) in &abs_pins {
                    let qnid = pin_net.get(qk).copied().unwrap_or(u16::MAX);
                    if qnid == nid {
                        continue;
                    }
                    if qp.pad.layers != 0xFF && qp.pad.layers & (1 << l0) == 0 {
                        continue;
                    }
                    let qcx = qp.x + qp.pad.ox;
                    let qcy = qp.y + qp.pad.oy;
                    if (qcx - pcx).abs() > reach + qp.pad.hw
                        || (qcy - pcy).abs() > reach + qp.pad.hh
                    {
                        continue;
                    }
                    let gx = (qcx - qp.pad.hw - pcx.max(ex))
                        .max(pcx.min(ex) - (qcx + qp.pad.hw))
                        .max(0.0);
                    let gy = (qcy - qp.pad.hh - pcy.max(ey))
                        .max(pcy.min(ey) - (qcy + qp.pad.hh))
                        .max(0.0);
                    if (gx * gx + gy * gy).sqrt() < lane - 1.0 {
                        legal = false;
                        break;
                    }
                }
                if !legal {
                    break; // a longer stub on this line only gets worse
                }
                // claim the corridor: foreign track centerlines must stay
                // width+clearance away from the stub line
                let mark_r = width + clearance - 1.0;
                let mut undo: Vec<(usize, u16)> = Vec::new();
                let x_lo = (((pcx.min(ex) - mark_r - bx0) / pitch).floor() as isize).max(0);
                let x_hi = (((pcx.max(ex) + mark_r - bx0) / pitch).ceil() as isize)
                    .min(gw as isize - 1);
                let y_lo = (((pcy.min(ey) - mark_r - by0) / pitch).floor() as isize).max(0);
                let y_hi = (((pcy.max(ey) + mark_r - by0) / pitch).ceil() as isize)
                    .min(gh as isize - 1);
                for y in y_lo..=y_hi {
                    for x in x_lo..=x_hi {
                        let px = bx0 + x as f64 * pitch;
                        let py = by0 + y as f64 * pitch;
                        let t = (((px - pcx) * (ex - pcx) + (py - pcy) * (ey - pcy)) / len2)
                            .clamp(0.0, 1.0);
                        let qx = pcx + t * (ex - pcx);
                        let qy = pcy + t * (ey - pcy);
                        let d = ((px - qx) * (px - qx) + (py - qy) * (py - qy)).sqrt();
                        if d <= mark_r {
                            let ci = idx(x as usize, y as usize, l0);
                            let c = &mut owner[ci];
                            if *c == 0 {
                                undo.push((ci, 0));
                                *c = nid;
                            } else if *c != nid && *c != u16::MAX {
                                undo.push((ci, *c));
                                *c = u16::MAX;
                            }
                        }
                    }
                }
                // the corridor must not orphan ANY nearby pin's escape
                // (seals cross component boundaries on dense placements)
                let mut orphaned = false;
                for (sk, sp) in &abs_pins {
                    if sk == pname || sp.pad.layers == 0xFF {
                        continue;
                    }
                    let scx = sp.x + sp.pad.ox;
                    let scy = sp.y + sp.pad.oy;
                    if scx < pcx.min(ex) - 2500.0
                        || scx > pcx.max(ex) + 2500.0
                        || scy < pcy.min(ey) - 2500.0
                        || scy > pcy.max(ey) + 2500.0
                    {
                        continue;
                    }
                    let snid = match pin_net.get(sk) {
                        Some(&n) if n != u16::MAX && n != nid => n,
                        _ => continue,
                    };
                    if skip.contains(&nets[(snid - 1) as usize].name) {
                        continue;
                    }
                    let sl0 = match (0..nl).find(|&l| sp.pad.layers & (1 << l) != 0) {
                        Some(l) => l,
                        None => continue,
                    };
                    // seed from the pad's full copper extent plus its
                    // 4-neighbors (fine-pitch center cells are often contested)
                    let srx = sp.pad.hw + width / 2.0;
                    let sry = sp.pad.hh + width / 2.0;
                    let sx_lo = (((scx - srx - bx0) / pitch).floor() as isize).max(0);
                    let sx_hi =
                        (((scx + srx - bx0) / pitch).ceil() as isize).min(gw as isize - 1);
                    let sy_lo = (((scy - sry - by0) / pitch).floor() as isize).max(0);
                    let sy_hi =
                        (((scy + sry - by0) / pitch).ceil() as isize).min(gh as isize - 1);
                    let mut sseen: HashSet<(usize, usize)> = HashSet::new();
                    let mut sq: std::collections::VecDeque<(usize, usize)> =
                        std::collections::VecDeque::new();
                    for y in sy_lo..=sy_hi {
                        for x in sx_lo..=sx_hi {
                            let ddx = (bx0 + x as f64 * pitch) - scx;
                            let ddy = (by0 + y as f64 * pitch) - scy;
                            if ddx.abs() > srx || ddy.abs() > sry {
                                continue;
                            }
                            // seed exactly like A* does: the pad's own cells,
                            // not their neighbors (neighbors can jump a wall)
                            let (x, y) = (x as usize, y as usize);
                            if !sseen.contains(&(x, y)) {
                                let o = owner[idx(x, y, sl0)];
                                if o == 0 || o == snid {
                                    sseen.insert((x, y));
                                    sq.push_back((x, y));
                                }
                            }
                        }
                    }
                    let mut sescape = false;
                    if sq.is_empty() {
                        // entry possible only via target cells: orphaned if the
                        // corridor claimed a cell adjacent to this pad
                        sescape = !undo.iter().any(|&(ci, _)| {
                            let cl = ci / (gw * gh);
                            let cx2 = ci % gw;
                            let cy2 = (ci / gw) % gh;
                            cl == sl0
                                && (sx_lo - 1..=sx_hi + 1).contains(&(cx2 as isize))
                                && (sy_lo - 1..=sy_hi + 1).contains(&(cy2 as isize))
                        });
                    }
                    let mut svis = 0usize;
                    while let Some((x, y)) = sq.pop_front() {
                        svis += 1;
                        if svis > 1500 {
                            sescape = true;
                            break;
                        }
                        for (nx, ny) in [
                            (x.wrapping_sub(1), y),
                            (x + 1, y),
                            (x, y.wrapping_sub(1)),
                            (x, y + 1),
                        ] {
                            if nx < gw && ny < gh && !sseen.contains(&(nx, ny)) {
                                let o = owner[idx(nx, ny, sl0)];
                                if o == 0 || o == snid {
                                    sseen.insert((nx, ny));
                                    sq.push_back((nx, ny));
                                }
                            }
                        }
                    }
                    if !sescape {
                        orphaned = true;
                        break;
                    }
                }
                if orphaned {
                    for (ci, v) in undo {
                        owner[ci] = v;
                    }
                    continue; // try a longer stub or another direction
                }
                let net_name = nets[(nid - 1) as usize].name.clone();
                stub_wires
                    .entry(net_name)
                    .or_default()
                    .push((l0, vec![(pcx, pcy), (ex, ey)]));
                eprintln!(
                    "  stub {} ({}): dir ({:.0},{:.0}) len {:.2}mm",
                    pname,
                    nets[(nid - 1) as usize].name,
                    ux,
                    uy,
                    (len2.sqrt() / 1000.0)
                );
                stub_end.insert(pname.clone(), idx(cxe, cye, l0));
                stub_count += 1;
                new_stubs += 1;
                placed = true;
                break 'dirs;
            }
        }
        if !placed {
            eprintln!(
                "  stub FAILED for {} ({}) — walled with no legal escape line",
                pname,
                nets[(nid - 1) as usize].name
            );
        }
    }
    if new_stubs == 0 {
        break;
    }
    }
    if stub_count > 0 {
        eprintln!("fanout: {} escape stubs for walled fine-pitch pads", stub_count);
    }

    // ---------- route: PathFinder negotiated congestion -------------------
    // owner = HARD constraints (pads). Routed copper is SOFT: nets may
    // overlap mid-iteration; shared cells get present + history penalties
    // until every conflict resolves (McMurchie & Ebeling, 1995).
    let pad_owner = owner;
    let via_cost: u32 = 40;
    let via_keep: isize = 1; // 3x3 @ rule-safe pitch satisfies via-via and via-track
    let mut track_cnt: Vec<u16> = vec![0; ncell];
    let mut ring_cnt: Vec<u16> = vec![0; ncell];
    let mut center_cnt: Vec<u16> = vec![0; gw * gh];
    let mut hist: Vec<u16> = vec![0; ncell];

    let hpwl = |n: &Net| -> f64 {
        let pts: Vec<&AbsPin> = n.pins.iter().filter_map(|p| abs_pins.get(p)).collect();
        if pts.len() < 2 {
            return 0.0;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for p in pts {
            x0 = x0.min(p.x);
            y0 = y0.min(p.y);
            x1 = x1.max(p.x);
            y1 = y1.max(p.y);
        }
        (x1 - x0) + (y1 - y0)
    };

    struct Job {
        ni: usize,
        nid: u16,
        pin_cells: Vec<Vec<usize>>,
        pin_names: Vec<String>,
    }
    #[derive(Clone)]
    struct NetRoute {
        track: Vec<usize>,          // path cells (layer-indexed)
        ring: Vec<usize>,           // via keepout cells (all layers)
        centers: Vec<usize>,        // via centers (2D cell index)
        paths: Vec<(usize, Vec<(usize, usize)>)>,
        vias: Vec<(usize, usize)>,
    }

    let mut jobs: Vec<Job> = Vec::new();
    for (ni, net) in nets.iter().enumerate() {
        if skip.contains(&net.name) || net.pins.len() < 2 {
            continue;
        }
        let nid = net_id_of[&net.name];
        let mut pin_cells: Vec<Vec<usize>> = Vec::new();
        let mut pin_names: Vec<String> = Vec::new();
        for p in &net.pins {
            if let Some(ap) = abs_pins.get(p) {
                // target = every cell whose center copper lands ON the pad
                // (sub-grid pads can have their nearest cell claimed by a
                // neighboring pad's clearance halo — the full extent restores
                // an entry point)
                let pcx = ap.x + ap.pad.ox;
                let pcy = ap.y + ap.pad.oy;
                let rx = ap.pad.hw + width / 2.0;
                let ry = ap.pad.hh + width / 2.0;
                let mut cells = Vec::new();
                let x_lo = (((pcx - rx - bx0) / pitch).floor() as isize).max(0);
                let x_hi = (((pcx + rx - bx0) / pitch).ceil() as isize).min(gw as isize - 1);
                let y_lo = (((pcy - ry - by0) / pitch).floor() as isize).max(0);
                let y_hi = (((pcy + ry - by0) / pitch).ceil() as isize).min(gh as isize - 1);
                for y in y_lo..=y_hi {
                    for x in x_lo..=x_hi {
                        let ddx = (bx0 + x as f64 * pitch) - pcx;
                        let ddy = (by0 + y as f64 * pitch) - pcy;
                        let miss = if ap.pad.circle { (ddx * ddx + ddy * ddy).sqrt() > rx.min(ry) } else { ddx.abs() > rx || ddy.abs() > ry };
                        if miss {
                            continue;
                        }
                        for l in 0..nl {
                            if ap.pad.layers & (1 << l) != 0 {
                                cells.push(idx(x as usize, y as usize, l));
                            }
                        }
                    }
                }
                if cells.is_empty() {
                    // pad smaller than a cell: fall back to nearest cell
                    let (cx, cy) = to_cell(pcx, pcy);
                    for l in 0..nl {
                        if ap.pad.layers & (1 << l) != 0 {
                            cells.push(idx(cx, cy, l));
                        }
                    }
                }
                if let Some(&sc) = stub_end.get(p) {
                    cells.push(sc); // routed continuation point of the fanout stub
                }
                if !cells.is_empty() {
                    cells.sort();
                    cells.dedup();
                    pin_cells.push(cells);
                    pin_names.push(p.clone());
                }
            }
        }
        if pin_cells.len() >= 2 {
            jobs.push(Job { ni, nid, pin_cells, pin_names });
        }
    }
    // route long nets first under negotiation (they have fewest alternatives)
    jobs.sort_by(|a, b| {
        hpwl(&nets[b.ni])
            .partial_cmp(&hpwl(&nets[a.ni]))
            .unwrap()
    });
    ATTEMPTED.store(jobs.len(), std::sync::atomic::Ordering::Relaxed);

    let mut routes: Vec<Option<NetRoute>> = (0..jobs.len()).map(|_| None).collect();
    let mut to_route: Vec<usize> = (0..jobs.len()).collect();
    let mut pres_fac: u32 = 1;
    // negotiation spreads congestion; the final sweep disables sharing so every
    // net it lands is exclusive (clean copper from negotiation stays frozen)
    let negotiate_iters = 140;
    let max_iters = negotiate_iters + 24;
    let mut hard_mode = false;
    struct Txn {
        fji: usize,
        ripped: Vec<usize>,
        saved: Vec<(usize, NetRoute)>,
        phase: u8,
        rounds: usize,
    }
    let mut txn: Option<Txn> = None;
    let mut txn_dead: HashSet<usize> = HashSet::new();
    let mut retried: HashMap<usize, usize> = HashMap::new();
    let mut best_conflicts = usize::MAX;
    let mut stall = 0usize;

    for iter in 0..max_iters {
        for &ji in &to_route {
            let job = &jobs[ji];
            let nid = job.nid;
            // remove own previous usage
            if let Some(r) = routes[ji].take() {
                for c in r.track {
                    track_cnt[c] = track_cnt[c].saturating_sub(1);
                }
                for c in r.ring {
                    ring_cnt[c] = ring_cnt[c].saturating_sub(1);
                }
                for c in r.centers {
                    center_cnt[c] = center_cnt[c].saturating_sub(1);
                }
            }
            // route all pins as a tree
            let mut connected: Vec<usize> = job.pin_cells[0].clone();
            let mut track_set: HashSet<usize> = connected.iter().cloned().collect();
            let mut ring_set: HashSet<usize> = HashSet::new();
            let mut center_set: Vec<usize> = Vec::new();
            let mut net_paths: Vec<(usize, Vec<(usize, usize)>)> = Vec::new();
            let mut net_vias: Vec<(usize, usize)> = Vec::new();
            let mut ok = true;

            for (pci, pc) in job.pin_cells.iter().enumerate().skip(1) {
                let targets: HashSet<usize> = pc.iter().cloned().collect();
                let t0c = pc[0];
                let (tx, ty) = (t0c % gw, (t0c / gw) % gh);
                let h = |c: usize| -> u32 {
                    let x = c % gw;
                    let y = (c / gw) % gh;
                    ((x as isize - tx as isize).abs() + (y as isize - ty as isize).abs())
                        as u32
                };
                let mut dist: HashMap<usize, u32> = HashMap::new();
                let mut prev: HashMap<usize, usize> = HashMap::new();
                let mut heap: BinaryHeap<std::cmp::Reverse<(u32, usize)>> = BinaryHeap::new();
                for &s in &connected {
                    dist.insert(s, 0);
                    heap.push(std::cmp::Reverse((h(s), s)));
                }
                let mut found: Option<usize> = None;
                let mut expansions = 0usize;
                while let Some(std::cmp::Reverse((f, c))) = heap.pop() {
                    let g = *dist.get(&c).unwrap_or(&u32::MAX);
                    if f.saturating_sub(h(c)) > g {
                        continue;
                    }
                    if targets.contains(&c) {
                        found = Some(c);
                        break;
                    }
                    expansions += 1;
                    if expansions > 3_000_000 {
                        break;
                    }
                    let x = c % gw;
                    let y = (c / gw) % gh;
                    let l = c / (gw * gh);
                    // congestion-priced step cost
                    let price = |nc: usize, base: u32| -> Option<u32> {
                        let o = pad_owner[nc];
                        if o != 0 && o != nid {
                            // a target cell contains OUR pad copper even when a
                            // neighboring pad owns/contests it on the grid
                            if targets.contains(&nc) {
                                return Some(base);
                            }
                            return None;
                        }
                        if hard_mode {
                            if track_cnt[nc] > 0 || ring_cnt[nc] > 0 {
                                return None;
                            }
                            return Some(base + hist[nc] as u32);
                        }
                        let share = track_cnt[nc] as u32 + ring_cnt[nc] as u32;
                        Some(base + pres_fac * share + hist[nc] as u32)
                    };
                    let mut push =
                        |nc: usize,
                         base: u32,
                         dist: &mut HashMap<usize, u32>,
                         prev: &mut HashMap<usize, usize>,
                         heap: &mut BinaryHeap<std::cmp::Reverse<(u32, usize)>>| {
                            if let Some(cost) = price(nc, base) {
                                let ng = g + cost;
                                if ng < *dist.get(&nc).unwrap_or(&u32::MAX) {
                                    dist.insert(nc, ng);
                                    prev.insert(nc, c);
                                    heap.push(std::cmp::Reverse((ng + h(nc), nc)));
                                }
                            }
                        };
                    let step: u32 = if l + 1 == nl { 3 } else { 1 };
                    if x > 0 {
                        push(idx(x - 1, y, l), step, &mut dist, &mut prev, &mut heap);
                    }
                    if x + 1 < gw {
                        push(idx(x + 1, y, l), step, &mut dist, &mut prev, &mut heap);
                    }
                    if y > 0 {
                        push(idx(x, y - 1, l), step, &mut dist, &mut prev, &mut heap);
                    }
                    if y + 1 < gh {
                        push(idx(x, y + 1, l), step, &mut dist, &mut prev, &mut heap);
                    }
                    if nl > 1 {
                        // via: ring must be pad-free on all layers (hard rule)
                        let mut via_hard_ok = true;
                        'ring: for dy in -via_keep..=via_keep {
                            for dx in -via_keep..=via_keep {
                                let nx = x as isize + dx;
                                let ny = y as isize + dy;
                                if nx < 0
                                    || ny < 0
                                    || nx >= gw as isize
                                    || ny >= gh as isize
                                {
                                    via_hard_ok = false;
                                    break 'ring;
                                }
                                for ll in 0..nl {
                                    let cc = idx(nx as usize, ny as usize, ll);
                                    let o = pad_owner[cc];
                                    if o != 0 && o != nid {
                                        via_hard_ok = false;
                                        break 'ring;
                                    }
                                    // hard mode: ring may not touch committed track
                                    if hard_mode && track_cnt[cc] > 0 {
                                        via_hard_ok = false;
                                        break 'ring;
                                    }
                                }
                            }
                        }
                        if via_hard_ok {
                            // price foreign via centers in the 3x3 (centers <2 cells apart violate)
                            let mut near_centers: u32 = 0;
                            for dy in -1..=1isize {
                                for dx in -1..=1isize {
                                    let nx = x as isize + dx;
                                    let ny = y as isize + dy;
                                    if nx >= 0 && ny >= 0 && (nx as usize) < gw && (ny as usize) < gh {
                                        near_centers += center_cnt[ny as usize * gw + nx as usize] as u32;
                                    }
                                }
                            }
                            if !(hard_mode && near_centers > 0) {
                                for ll in 0..nl {
                                    if ll != l {
                                        push(
                                            idx(x, y, ll),
                                            via_cost + pres_fac * 2 * near_centers,
                                            &mut dist,
                                            &mut prev,
                                            &mut heap,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                match found {
                    Some(end) => {
                        let mut cells = vec![end];
                        let mut cur = end;
                        while dist.get(&cur) != Some(&0) {
                            match prev.get(&cur) {
                                Some(&p) => {
                                    cells.push(p);
                                    cur = p;
                                }
                                None => break,
                            }
                        }
                        cells.reverse();
                        for &c in &cells {
                            track_set.insert(c);
                            connected.push(c);
                        }
                        let mut run: Vec<(usize, usize)> = Vec::new();
                        let mut run_layer = cells[0] / (gw * gh);
                        for &c in &cells {
                            let l = c / (gw * gh);
                            let x = c % gw;
                            let y = (c / gw) % gh;
                            if l != run_layer {
                                if run.len() > 1 {
                                    net_paths.push((run_layer, run.clone()));
                                }
                                if let Some(&(vx, vy)) = run.last() {
                                    net_vias.push((vx, vy));
                                    center_set.push(vy * gw + vx);
                                    for dy in -via_keep..=via_keep {
                                        for dx in -via_keep..=via_keep {
                                            let nx = vx as isize + dx;
                                            let ny = vy as isize + dy;
                                            if nx >= 0
                                                && ny >= 0
                                                && (nx as usize) < gw
                                                && (ny as usize) < gh
                                            {
                                                for ll in 0..nl {
                                                    ring_set.insert(idx(
                                                        nx as usize,
                                                        ny as usize,
                                                        ll,
                                                    ));
                                                }
                                            }
                                        }
                                    }
                                }
                                run = vec![(x, y)];
                                run_layer = l;
                            } else {
                                run.push((x, y));
                            }
                        }
                        if run.len() > 1 {
                            net_paths.push((run_layer, run));
                        }
                    }
                    None => {
                        if hard_mode {
                            let blocked = pc
                                .iter()
                                .filter(|&&c| pad_owner[c] != 0 && pad_owner[c] != nid)
                                .count();
                            eprintln!(
                                "  FAIL {}: pin {} unreachable from {} ({} expansions, {}/{} target cells foreign/contested)",
                                nets[job.ni].name,
                                job.pin_names[pci],
                                job.pin_names[0],
                                expansions, blocked, pc.len()
                            );
                        }
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                let track: Vec<usize> = track_set
                    .into_iter()
                    .filter(|&c| pad_owner[c] == 0)
                    .collect();
                let ring: Vec<usize> = ring_set
                    .into_iter()
                    .filter(|&c| pad_owner[c] == 0)
                    .collect();
                for &c in &track {
                    track_cnt[c] = track_cnt[c].saturating_add(1);
                }
                for &c in &ring {
                    ring_cnt[c] = ring_cnt[c].saturating_add(1);
                }
                for &c in &center_set {
                    center_cnt[c] = center_cnt[c].saturating_add(1);
                }
                routes[ji] = Some(NetRoute {
                    track,
                    ring,
                    centers: center_set,
                    paths: net_paths,
                    vias: net_vias,
                });
            }
        }

        // conflict detection: any cell shared by >1 net (vs hard pads handled)
        let mut conflicted: HashSet<usize> = HashSet::new();
        let mut hot: HashSet<usize> = HashSet::new();
        for (ji, r) in routes.iter().enumerate() {
            match r {
                Some(nr) => {
                    let own_ring: HashSet<usize> = nr.ring.iter().cloned().collect();
                    let mut bad = false;
                    for &c in &nr.track {
                        let foreign_ring =
                            ring_cnt[c] as i32 - if own_ring.contains(&c) { 1 } else { 0 };
                        if track_cnt[c] > 1 || foreign_ring > 0 {
                            bad = true;
                            hot.insert(c);
                        }
                    }
                    // via centers: foreign center within 1 cell violates spacing
                    for &c2 in &nr.centers {
                        let (vx, vy) = (c2 % gw, c2 / gw);
                        let mut cnt = 0u32;
                        for dy in -1..=1isize {
                            for dx in -1..=1isize {
                                let nx = vx as isize + dx;
                                let ny = vy as isize + dy;
                                if nx >= 0 && ny >= 0 && (nx as usize) < gw && (ny as usize) < gh {
                                    cnt += center_cnt[ny as usize * gw + nx as usize] as u32;
                                }
                            }
                        }
                        let own_here: u32 = nr
                            .centers
                            .iter()
                            .filter(|&&o| {
                                let (ox, oy) = (o % gw, o / gw);
                                (ox as isize - vx as isize).abs() <= 1
                                    && (oy as isize - vy as isize).abs() <= 1
                            })
                            .count() as u32;
                        if cnt > own_here {
                            bad = true;
                            for ll in 0..nl {
                                hot.insert(idx(vx, vy, ll));
                            }
                        }
                    }
                    if bad {
                        conflicted.insert(ji);
                    }
                }
                None => {
                    conflicted.insert(ji);
                }
            }
        }
        for &c in &hot {
            hist[c] = hist[c].saturating_add(2);
        }
        eprintln!(
            "iter {}: {} conflicted (pres_fac {})",
            iter,
            conflicted.len(),
            pres_fac
        );
        if !hard_mode && conflicted.is_empty() {
            break;
        }
        if hard_mode {
            // transactional swap with iterative deepening: rip the nets
            // sealing a failed net's pin pockets, route the failed net ALONE
            // (rescanning up to 3 times — seals can be layered), then route
            // the ripped nets back. Roll back if the bundle doesn't fully
            // land, so the routed total can never get worse.
            let mut fixed_fji: Option<usize> = None;
            if let Some(mut t) = txn.take() {
                let tname = nets[jobs[t.fji].ni].name.clone();
                if t.phase == 1 && routes[t.fji].is_some() {
                    // the failed net landed; route the ripped ones back
                    let mut back: Vec<usize> = t
                        .ripped
                        .iter()
                        .cloned()
                        .filter(|&ji| routes[ji].is_none())
                        .collect();
                    if back.is_empty() {
                        eprintln!("txn: {} swapped in cleanly", tname);
                    } else {
                        back.sort_by(|&a, &b| {
                            hpwl(&nets[jobs[a].ni])
                                .partial_cmp(&hpwl(&nets[jobs[b].ni]))
                                .unwrap()
                        });
                        t.phase = 2;
                        to_route = back;
                        txn = Some(t);
                        continue;
                    }
                } else if t.phase == 1 && t.rounds < 3 {
                    // still failing: deepen — rescan with the pocket grown
                    t.rounds += 1;
                    fixed_fji = Some(t.fji);
                    txn = Some(t);
                } else {
                    // phase 2 evaluation, or out of deepening rounds
                    let all_ok = routes[t.fji].is_some()
                        && t.ripped.iter().all(|&ji| routes[ji].is_some());
                    if t.phase == 2 && all_ok {
                        eprintln!("txn: {} swapped in cleanly", tname);
                    } else {
                        for &ji in std::iter::once(&t.fji).chain(t.ripped.iter()) {
                            if let Some(r) = routes[ji].take() {
                                for c in r.track {
                                    track_cnt[c] = track_cnt[c].saturating_sub(1);
                                }
                                for c in r.ring {
                                    ring_cnt[c] = ring_cnt[c].saturating_sub(1);
                                }
                                for c in r.centers {
                                    center_cnt[c] = center_cnt[c].saturating_sub(1);
                                }
                            }
                        }
                        for (ji, r) in t.saved {
                            for &c in &r.track {
                                track_cnt[c] = track_cnt[c].saturating_add(1);
                            }
                            for &c in &r.ring {
                                ring_cnt[c] = ring_cnt[c].saturating_add(1);
                            }
                            for &c in &r.centers {
                                center_cnt[c] = center_cnt[c].saturating_add(1);
                            }
                            routes[ji] = Some(r);
                        }
                        txn_dead.insert(t.fji);
                        eprintln!("txn: rollback for {}", tname);
                    }
                }
            }
            // pick (or continue) a failed net worth a swap attempt
            let mut started = false;
            let cands: Vec<usize> = match fixed_fji {
                Some(fji) => vec![fji],
                None => (0..jobs.len())
                    .filter(|&ji| routes[ji].is_none() && !txn_dead.contains(&ji))
                    .collect(),
            };
            // routed copper sealing pin pockets; copper is a wall here
            // exactly as it is for hard-mode A*
            let mut cell_nets: HashMap<usize, Vec<usize>> = HashMap::new();
            let mut center_map: HashMap<usize, Vec<usize>> = HashMap::new();
            let mut track_map: HashMap<usize, Vec<usize>> = HashMap::new();
            for (oji, r) in routes.iter().enumerate() {
                if let Some(nr) = r {
                    for &tc in nr.track.iter().chain(nr.ring.iter()) {
                        cell_nets.entry(tc).or_default().push(oji);
                    }
                    for &cc in &nr.centers {
                        center_map.entry(cc).or_default().push(oji);
                    }
                    for &tc in &nr.track {
                        track_map.entry(tc).or_default().push(oji);
                    }
                }
            }
            // the open field, with copper as walls: a pocket is open only if
            // it reaches the largest free component (size alone misleads)
            let mut field_label: Vec<Vec<u32>> = Vec::new();
            let mut field_main: Vec<u32> = Vec::new();
            for l in 0..nl {
                let mut lab = vec![0u32; gw * gh];
                let mut next = 0u32;
                let mut best_c = (0u32, 0usize);
                for s2 in 0..gw * gh {
                    let c3 = idx(s2 % gw, s2 / gw, l);
                    if lab[s2] != 0 || pad_owner[c3] != 0 || cell_nets.contains_key(&c3) {
                        continue;
                    }
                    next += 1;
                    let mut size = 0usize;
                    let mut st = vec![s2];
                    lab[s2] = next;
                    while let Some(c) = st.pop() {
                        size += 1;
                        let (x, y) = (c % gw, c / gw);
                        for (nx, ny) in [
                            (x.wrapping_sub(1), y),
                            (x + 1, y),
                            (x, y.wrapping_sub(1)),
                            (x, y + 1),
                        ] {
                            if nx < gw && ny < gh {
                                let n2 = ny * gw + nx;
                                let n3 = idx(nx, ny, l);
                                if lab[n2] == 0
                                    && pad_owner[n3] == 0
                                    && !cell_nets.contains_key(&n3)
                                {
                                    lab[n2] = next;
                                    st.push(n2);
                                }
                            }
                        }
                    }
                    if size > best_c.1 {
                        best_c = (next, size);
                    }
                }
                field_label.push(lab);
                field_main.push(best_c.0);
            }
            'cand: for fji in cands {
                let fnid = jobs[fji].nid;
                let mut found: HashSet<usize> = HashSet::new();
                let mut any_closed = false;
                for start in jobs[fji].pin_cells.clone() {
                    let mut sealers: HashSet<usize> = HashSet::new();
                    let mut seen: HashSet<usize> = start.iter().cloned().collect();
                    let mut q: std::collections::VecDeque<usize> = start.into();
                    let mut pops = 0usize;
                    let mut open = false;
                    while let Some(c) = q.pop_front() {
                        pops += 1;
                        if pops > 30_000 {
                            open = true; // safety cap
                            break;
                        }
                        if let Some(v) = cell_nets.get(&c) {
                            for &oji in v {
                                if oji != fji {
                                    sealers.insert(oji);
                                }
                            }
                            continue; // copper is a wall: record, don't traverse
                        }
                        let x = c % gw;
                        let y = (c / gw) % gh;
                        let l = c / (gw * gh);
                        if pad_owner[c] == 0
                            && field_label[l][y * gw + x] == field_main[l]
                        {
                            open = true; // touches the main field: escapable
                            break;
                        }
                        let mut nbrs: Vec<usize> = Vec::new();
                        if x > 0 {
                            nbrs.push(idx(x - 1, y, l));
                        }
                        if x + 1 < gw {
                            nbrs.push(idx(x + 1, y, l));
                        }
                        if y > 0 {
                            nbrs.push(idx(x, y - 1, l));
                        }
                        if y + 1 < gh {
                            nbrs.push(idx(x, y + 1, l));
                        }
                        // layer hop only where a via could legally sit
                        let mut via_ok = true;
                        'vr: for dy in -via_keep..=via_keep {
                            for dx in -via_keep..=via_keep {
                                let nx = x as isize + dx;
                                let ny = y as isize + dy;
                                if nx < 0
                                    || ny < 0
                                    || nx >= gw as isize
                                    || ny >= gh as isize
                                {
                                    via_ok = false;
                                    break 'vr;
                                }
                                for ll in 0..nl {
                                    let o =
                                        pad_owner[idx(nx as usize, ny as usize, ll)];
                                    if o != 0 && o != fnid {
                                        via_ok = false;
                                        break 'vr;
                                    }
                                }
                            }
                        }
                        if via_ok {
                            // committed track in the via ring blocks the hop in
                            // hard mode — those nets are rippable sealers
                            let mut ring_jis: Vec<usize> = Vec::new();
                            for dy in -via_keep..=via_keep {
                                for dx in -via_keep..=via_keep {
                                    let nx = x as isize + dx;
                                    let ny = y as isize + dy;
                                    if nx >= 0
                                        && ny >= 0
                                        && (nx as usize) < gw
                                        && (ny as usize) < gh
                                    {
                                        for ll in 0..nl {
                                            if let Some(v) = track_map.get(&idx(
                                                nx as usize,
                                                ny as usize,
                                                ll,
                                            )) {
                                                ring_jis.extend(
                                                    v.iter().filter(|&&o| o != fji),
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                            // foreign via centers within 1 cell block the hop —
                            // record them: they are rippable sealers
                            let mut center_jis: Vec<usize> = Vec::new();
                            for dy in -1..=1isize {
                                for dx in -1..=1isize {
                                    let nx = x as isize + dx;
                                    let ny = y as isize + dy;
                                    if nx >= 0
                                        && ny >= 0
                                        && (nx as usize) < gw
                                        && (ny as usize) < gh
                                    {
                                        if let Some(v) = center_map
                                            .get(&(ny as usize * gw + nx as usize))
                                        {
                                            center_jis
                                                .extend(v.iter().filter(|&&o| o != fji));
                                        }
                                    }
                                }
                            }
                            if center_jis.is_empty() && ring_jis.is_empty() {
                                for ll in 0..nl {
                                    if ll != l {
                                        nbrs.push(idx(x, y, ll));
                                    }
                                }
                            } else {
                                sealers.extend(center_jis);
                                sealers.extend(ring_jis);
                            }
                        }
                        for nc in nbrs {
                            if seen.contains(&nc) {
                                continue;
                            }
                            let o = pad_owner[nc];
                            if o == 0 || o == fnid {
                                seen.insert(nc);
                                q.push_back(nc);
                            }
                        }
                    }
                    if open {
                        continue;
                    }
                    any_closed = true;
                    found.extend(sealers);
                }
                if found.is_empty() && !any_closed {
                    // every pocket reaches the field now (earlier swaps moved
                    // the copper): no rip needed, just route it again
                    if txn.is_some() {
                        to_route = vec![fji];
                        started = true;
                        break;
                    }
                    let n = retried.entry(fji).or_insert(0);
                    if *n < 2 {
                        *n += 1;
                        eprintln!(
                            "txn: {} pockets opened — direct retry {}",
                            nets[jobs[fji].ni].name,
                            n
                        );
                        to_route = vec![fji];
                        started = true;
                        break;
                    }
                }
                if found.is_empty() || found.len() > 24 {
                    // nothing rippable (or implausibly much) — give up on it
                    if let Some(t) = txn.take() {
                        for &ji in std::iter::once(&t.fji).chain(t.ripped.iter()) {
                            if let Some(r) = routes[ji].take() {
                                for c in r.track {
                                    track_cnt[c] = track_cnt[c].saturating_sub(1);
                                }
                                for c in r.ring {
                                    ring_cnt[c] = ring_cnt[c].saturating_sub(1);
                                }
                                for c in r.centers {
                                    center_cnt[c] = center_cnt[c].saturating_sub(1);
                                }
                            }
                        }
                        for (ji, r) in t.saved {
                            for &c in &r.track {
                                track_cnt[c] = track_cnt[c].saturating_add(1);
                            }
                            for &c in &r.ring {
                                ring_cnt[c] = ring_cnt[c].saturating_add(1);
                            }
                            for &c in &r.centers {
                                center_cnt[c] = center_cnt[c].saturating_add(1);
                            }
                            routes[ji] = Some(r);
                        }
                        eprintln!("txn: rollback for {} (pocket not rippable)", nets[jobs[t.fji].ni].name);
                    }
                    txn_dead.insert(fji);
                    continue 'cand;
                }
                // rip the sealers (append to the active txn if deepening)
                let mut saved_now: Vec<(usize, NetRoute)> = Vec::new();
                for &ji in &found {
                    if let Some(r) = routes[ji].take() {
                        for &c in &r.track {
                            track_cnt[c] = track_cnt[c].saturating_sub(1);
                        }
                        for &c in &r.ring {
                            ring_cnt[c] = ring_cnt[c].saturating_sub(1);
                        }
                        for &c in &r.centers {
                            center_cnt[c] = center_cnt[c].saturating_sub(1);
                        }
                        saved_now.push((ji, r));
                    }
                }
                let ripped_now: Vec<usize> = found.into_iter().collect();
                match txn.as_mut() {
                    Some(t) => {
                        eprintln!(
                            "txn: {} deepens (round {}), rips {} more",
                            nets[jobs[fji].ni].name,
                            t.rounds,
                            ripped_now.len()
                        );
                        t.ripped.extend(ripped_now);
                        t.saved.extend(saved_now);
                    }
                    None => {
                        eprintln!(
                            "txn: {} rips {} sealers",
                            nets[jobs[fji].ni].name,
                            ripped_now.len()
                        );
                        txn = Some(Txn {
                            fji,
                            ripped: ripped_now,
                            saved: saved_now,
                            phase: 1,
                            rounds: 1,
                        });
                    }
                }
                to_route = vec![fji];
                started = true;
                break;
            }
            if !started {
                if fixed_fji.is_some() {
                    // the deepened candidate died; rescan the rest next pass
                    to_route = Vec::new();
                    continue;
                }
                break;
            }
            continue;
        }
        if conflicted.len() < best_conflicts {
            best_conflicts = conflicted.len();
            stall = 0;
        } else {
            stall += 1;
        }
        // stall only counts once sharing is meaningfully priced
        if iter + 1 >= negotiate_iters || (pres_fac >= 64 && stall >= 12) {
            // negotiation didn't fully converge: rip every dirty net at once,
            // then one exclusive sweep against the frozen clean copper
            hard_mode = true;
            // exclusive sweep: nets with pins in tight pockets first — once
            // someone else's copper bricks up a pocket's only exit, that net
            // can never route. Tie-break: short nets first (long can detour).
            let tightness = |ji: usize| -> u32 {
                let mut m = u32::MAX;
                for pc in &jobs[ji].pin_cells {
                    let c = pc[0];
                    let l = c / (gw * gh);
                    let x = c % gw;
                    let y = (c / gw) % gh;
                    let mut free = 0u32;
                    for dy in -5..=5isize {
                        for dx in -5..=5isize {
                            let nx = x as isize + dx;
                            let ny = y as isize + dy;
                            if nx >= 0
                                && ny >= 0
                                && (nx as usize) < gw
                                && (ny as usize) < gh
                                && pad_owner[idx(nx as usize, ny as usize, l)] == 0
                            {
                                free += 1;
                            }
                        }
                    }
                    m = m.min(free);
                }
                m
            };
            let mut dirty: Vec<usize> = conflicted.into_iter().collect();
            dirty.sort_by(|&a, &b| {
                tightness(a).cmp(&tightness(b)).then(
                    hpwl(&nets[jobs[a].ni])
                        .partial_cmp(&hpwl(&nets[jobs[b].ni]))
                        .unwrap(),
                )
            });
            for &ji in &dirty {
                if let Some(r) = routes[ji].take() {
                    for c in r.track {
                        track_cnt[c] = track_cnt[c].saturating_sub(1);
                    }
                    for c in r.ring {
                        ring_cnt[c] = ring_cnt[c].saturating_sub(1);
                    }
                    for c in r.centers {
                        center_cnt[c] = center_cnt[c].saturating_sub(1);
                    }
                }
            }
            eprintln!("hard consolidation: re-routing {} dirty nets exclusively", dirty.len());
            to_route = dirty;
        } else {
            to_route = conflicted.into_iter().collect();
            to_route.sort();
            pres_fac = ((pres_fac * 5 / 4).max(pres_fac + 1)).min(256);
        }
    }

    let mut results: Vec<Routed> = Vec::new();
    let (mut routed_nets, mut failed_nets) = (0usize, 0usize);
    let mut failed_names: Vec<String> = Vec::new();
    let mut conflict_left = 0usize;
    for (ji, r) in routes.iter().enumerate() {
        match r {
            Some(nr) => {
                // emission gate: only conflict-free copper ships (DRC-clean guarantee)
                let own_ring: HashSet<usize> = nr.ring.iter().cloned().collect();
                let clean = nr.track.iter().all(|&c| {
                    let foreign_ring =
                        ring_cnt[c] as i32 - if own_ring.contains(&c) { 1 } else { 0 };
                    track_cnt[c] <= 1 && foreign_ring <= 0
                });
                if clean {
                    routed_nets += 1;
                    results.push(Routed {
                        name: nets[jobs[ji].ni].name.clone(),
                        paths: nr.paths.clone(),
                        vias: nr.vias.clone(),
                    });
                } else {
                    conflict_left += 1;
                    failed_nets += 1;
                    if failed_names.len() < 20 {
                        failed_names.push(nets[jobs[ji].ni].name.clone());
                    }
                }
            }
            None => {
                failed_nets += 1;
                if failed_names.len() < 20 {
                    failed_names.push(nets[jobs[ji].ni].name.clone());
                }
            }
        }
    }
    if conflict_left > 0 {
        eprintln!("WARNING: {} nets still share cells (not converged)", conflict_left);
    }

    // ---------- emit SES -------------------------------------------------------------
    // terminal snap: a wire ending at a target cell's center can miss the pad
    // copper by a hair (and sit too close to a fine-pitch neighbor). Snap path
    // endpoints landing on a pin's entry cells to the true pad center.
    let mut pin_entry: HashMap<String, HashMap<(usize, usize, usize), (f64, f64, f64, f64)>> =
        HashMap::new();
    for net in &nets {
        let m = pin_entry.entry(net.name.clone()).or_default();
        for p in &net.pins {
            if let Some(ap) = abs_pins.get(p) {
                let pcx = ap.x + ap.pad.ox;
                let pcy = ap.y + ap.pad.oy;
                let rx = ap.pad.hw + width / 2.0;
                let ry = ap.pad.hh + width / 2.0;
                let x_lo = (((pcx - rx - bx0) / pitch).floor() as isize).max(0);
                let x_hi = (((pcx + rx - bx0) / pitch).ceil() as isize).min(gw as isize - 1);
                let y_lo = (((pcy - ry - by0) / pitch).floor() as isize).max(0);
                let y_hi = (((pcy + ry - by0) / pitch).ceil() as isize).min(gh as isize - 1);
                for y in y_lo..=y_hi {
                    for x in x_lo..=x_hi {
                        let ddx = (bx0 + x as f64 * pitch) - pcx;
                        let ddy = (by0 + y as f64 * pitch) - pcy;
                        let miss = if ap.pad.circle { (ddx * ddx + ddy * ddy).sqrt() > rx.min(ry) } else { ddx.abs() > rx || ddy.abs() > ry };
                        if miss {
                            continue;
                        }
                        for l in 0..nl {
                            if ap.pad.layers & (1 << l) != 0 {
                                m.insert(
                                    (x as usize, y as usize, l),
                                    (pcx, pcy, ap.pad.hw, ap.pad.hh),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    let cell_xy = |x: usize, y: usize| -> (f64, f64) {
        (
            (bx0 + x as f64 * pitch) * resolution,
            (by0 + y as f64 * pitch) * resolution,
        )
    };
    let mut out = String::new();
    let short = design_name
        .rsplit('/')
        .next()
        .unwrap_or("board")
        .trim_end_matches(".dsn")
        .to_string();
    out.push_str(&format!("(session {}\n", short));
    out.push_str(&format!("  (base_design {})\n", short));
    // placement echo (required by KiCad's SES importer)
    out.push_str("  (placement\n");
    out.push_str(&format!("    (resolution um {})\n", resolution as i64));
    for comp in placement.kids("component") {
        let img_name = comp.list()[1].sym();
        out.push_str(&format!("    (component \"{}\"\n", img_name));
        for pl in comp.kids("place") {
            let l = pl.list();
            if l.len() < 5 {
                continue;
            }
            let cx: f64 = l[2].sym().parse().unwrap_or(0.0);
            let cy: f64 = l[3].sym().parse().unwrap_or(0.0);
            let rot = l.get(5).map(|s| s.sym()).unwrap_or("0");
            out.push_str(&format!(
                "      (place {} {} {} {} {})\n",
                l[1].sym(),
                (cx * resolution) as i64,
                (cy * resolution) as i64,
                l[4].sym(),
                rot
            ));
        }
        out.push_str("    )\n");
    }
    out.push_str("  )\n");
    out.push_str("  (routes\n");
    out.push_str(&format!("    (resolution um {})\n", resolution as i64));
    out.push_str("    (parser (host_cad \"flroute\") (host_version \"0.1\"))\n");
    // library_out: via padstack definition (importer must resolve via names)
    out.push_str("    (library_out\n");
    for ps in lib.kids("padstack") {
        if ps.list()[1].sym() == via_name {
            out.push_str(&format!("      (padstack \"{}\"\n", via_name));
            for sh in ps.kids("shape") {
                let inner = &sh.list()[1];
                let lname = inner.list().get(1).map(|s| s.sym()).unwrap_or("");
                let d: f64 = inner
                    .list()
                    .get(2)
                    .and_then(|s| s.sym().parse().ok())
                    .unwrap_or(0.0);
                out.push_str(&format!(
                    "        (shape (circle {} {} 0 0))\n",
                    lname,
                    (d * resolution) as i64
                ));
            }
            out.push_str("        (attach off)\n      )\n");
        }
    }
    out.push_str("    )\n");
    out.push_str("    (network_out\n");
    for r in &results {
        out.push_str(&format!("      (net \"{}\"\n", r.name));
        let entry = pin_entry.get(&r.name);
        // cells used more than once are tree junctions (or via sites): moving
        // a wire end there would break the join
        let mut use_count: HashMap<(usize, usize, usize), u32> = HashMap::new();
        for (l, cells) in &r.paths {
            for &(x, y) in cells.iter() {
                *use_count.entry((x, y, *l)).or_insert(0) += 1;
            }
        }
        for &(x, y) in &r.vias {
            for l in 0..nl {
                *use_count.entry((x, y, l)).or_insert(0) += 10;
            }
        }
        for (layer, cells) in &r.paths {
            let mut pts: Vec<(f64, f64)> = Vec::new();
            for (i, &(x, y)) in cells.iter().enumerate() {
                let (fx, fy) = cell_xy(x, y);
                if i >= 2 {
                    let n = pts.len();
                    let (ax, ay) = pts[n - 2];
                    let (bx, by) = pts[n - 1];
                    if ((bx - ax) * (fy - by) - (by - ay) * (fx - bx)).abs() < 1e-9 {
                        pts.pop();
                    }
                }
                pts.push((fx, fy));
            }
            // snap wire ends the MINIMUM distance toward the pad center that
            // guarantees copper overlap (full snap crosses fine-pitch neighbors)
            if let Some(m) = entry {
                let snap = |x: usize, y: usize, px: f64, py: f64, hw: f64, hh: f64| -> (f64, f64) {
                    let e0 = (bx0 + x as f64 * pitch, by0 + y as f64 * pitch);
                    let (dx, dy) = (e0.0 - px, e0.1 - py);
                    // inscribed safe region works for rect, roundrect, circle
                    // and oval pads alike; no move when already inside
                    let g = (hw.min(hh) + width / 2.0 - 75.0).max(25.0);
                    let d = (dx * dx + dy * dy).sqrt();
                    if d <= g {
                        return (e0.0 * resolution, e0.1 * resolution);
                    }
                    // prefer an axis-aligned move so adjacent entries stay
                    // grid-parallel instead of converging diagonally
                    let (amaj, amin) = if dx.abs() >= dy.abs() {
                        (dx.abs(), dy.abs())
                    } else {
                        (dy.abs(), dx.abs())
                    };
                    let _ = amaj;
                    if amin < g * 0.9 {
                        let nmaj = (g * g - amin * amin).sqrt() * 0.999;
                        let (nx, ny) = if dx.abs() >= dy.abs() {
                            (px + dx.signum() * nmaj, e0.1)
                        } else {
                            (e0.0, py + dy.signum() * nmaj)
                        };
                        return (nx * resolution, ny * resolution);
                    }
                    let t = g / d;
                    ((px + dx * t) * resolution, (py + dy * t) * resolution)
                };
                if let (Some(&(x0, y0)), Some(&(x1, y1))) = (cells.first(), cells.last()) {
                    if use_count.get(&(x0, y0, *layer)).copied().unwrap_or(0) <= 1 {
                        if let Some(&(px, py, hw, hh)) = m.get(&(x0, y0, *layer)) {
                            pts[0] = snap(x0, y0, px, py, hw, hh);
                        }
                    }
                    if use_count.get(&(x1, y1, *layer)).copied().unwrap_or(0) <= 1 {
                        if let Some(&(px, py, hw, hh)) = m.get(&(x1, y1, *layer)) {
                            let n = pts.len();
                            pts[n - 1] = snap(x1, y1, px, py, hw, hh);
                        }
                    }
                }
            }
            out.push_str(&format!(
                "        (wire (path {} {}",
                layers[*layer],
                (width * resolution) as i64
            ));
            for (x, y) in pts {
                out.push_str(&format!(" {} {}", x as i64, y as i64));
            }
            out.push_str("))\n");
        }
        for &(x, y) in &r.vias {
            let (fx, fy) = cell_xy(x, y);
            out.push_str(&format!(
                "        (via \"{}\" {} {})\n",
                via_name, fx as i64, fy as i64
            ));
        }
        if let Some(sw) = stub_wires.get(&r.name) {
            let used: HashSet<(usize, usize, usize)> = r
                .paths
                .iter()
                .flat_map(|(l, cells)| {
                    [cells.first(), cells.last()]
                        .into_iter()
                        .flatten()
                        .map(move |&(x, y)| (x, y, *l))
                        .collect::<Vec<_>>()
                })
                .collect();
            for (l, pts) in sw {
                // the stub's field end must be where a wire starts/ends
                let (ex, ey) = pts[pts.len() - 1];
                let (cx, cy) = to_cell(ex, ey);
                if !used.contains(&(cx, cy, *l)) {
                    continue;
                }
                out.push_str(&format!(
                    "        (wire (path {} {}",
                    layers[*l],
                    (width * resolution) as i64
                ));
                for &(x, y) in pts {
                    out.push_str(&format!(
                        " {} {}",
                        (x * resolution) as i64,
                        (y * resolution) as i64
                    ));
                }
                out.push_str("))\n");
            }
        }
        out.push_str("      )\n");
    }
    out.push_str("    )\n  )\n)\n");
    fs::write(&args[2], out).expect("write ses");

    eprintln!(
        "flroute: {} attempted, {} routed, {} failed in {:.2}s",
        ATTEMPTED.load(std::sync::atomic::Ordering::Relaxed),
        routed_nets,
        failed_nets,
        t0.elapsed().as_secs_f64()
    );
    if !failed_names.is_empty() {
        eprintln!("failed (first {}): {:?}", failed_names.len(), failed_names);
    }
}
