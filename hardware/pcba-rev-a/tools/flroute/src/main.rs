//! flroute — FirstLight PCB autorouter (v0).
//!
//! Drop-in for freerouting in the FL-1 pipeline: reads a KiCad-exported
//! Specctra DSN, grid-routes the signal nets with multi-source A* and
//! via support, and emits a Specctra SES that `pcbnew.ImportSpecctraSES`
//! accepts. Zone-served nets (GND / coil rail) are skipped — the pours
//! own them, same as the freerouting flow.
//!
//! v0 scope: uniform grid (0.4 mm), pad bounding-circle obstacles,
//! net ordering by HPWL, no rip-up. Validated differentially against
//! freerouting + KiCad DRC.

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
    layers: u8, // bitmask; 0xFF = all layers (THT)
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
        padstacks.insert(name, PadInfo { hw, hh, ox, oy, layers: mask });
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

    // ---------- route ---------------------------------------------------------------
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
    let mut order: Vec<usize> = (0..nets.len()).collect();
    order.sort_by(|&a, &b| hpwl(&nets[a]).partial_cmp(&hpwl(&nets[b])).unwrap());

    let via_cost: u32 = 40;
    let via_hw = padstacks
        .get(&via_name)
        .map(|p| p.hw.max(p.hh))
        .unwrap_or(mm(0.3));
    let via_keep: isize = 1; // 3x3 @ rule-safe pitch satisfies via-via and via-track
    let mut results: Vec<Routed> = Vec::new();
    let (mut routed_nets, mut failed_nets) = (0usize, 0usize);
    let mut failed_names: Vec<String> = Vec::new();

    let mut retry: Vec<(usize, u8)> = Vec::new();
    let pass_order: Vec<(usize, u8)> = order.iter().map(|&i| (i, 0u8)).collect();
    let mut queue: Vec<(usize, u8)> = pass_order;
    let mut qi = 0usize;
    loop {
        if qi >= queue.len() {
            if retry.is_empty() {
                break;
            }
            for &(r, a) in &retry {
                queue.push((r, a));
            }
            retry.clear();
        }
        let (ni, attempt) = queue[qi];
        let is_retry = attempt >= 3;
        qi += 1;
        let net = &nets[ni];
        if skip.contains(&net.name) || net.pins.len() < 2 {
            continue;
        }
        if attempt == 0 {
            ATTEMPTED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let nid = net_id_of[&net.name];
        let mut pin_cells: Vec<Vec<usize>> = Vec::new();
        for p in &net.pins {
            if let Some(ap) = abs_pins.get(p) {
                let (cx, cy) = to_cell(ap.x, ap.y);
                let mut cells = Vec::new();
                for l in 0..nl {
                    if ap.pad.layers & (1 << l) != 0 {
                        cells.push(idx(cx, cy, l));
                    }
                }
                if !cells.is_empty() {
                    pin_cells.push(cells);
                }
            }
        }
        if pin_cells.len() < 2 {
            continue;
        }

        let mut connected: Vec<usize> = pin_cells[0].clone();
        let mut net_paths: Vec<(usize, Vec<(usize, usize)>)> = Vec::new();
        let mut net_vias: Vec<(usize, usize)> = Vec::new();
        let mut ok = true;

        for pc in pin_cells.iter().skip(1) {
            let targets: HashSet<usize> = pc.iter().cloned().collect();
            let t0c = pc[0];
            let (tx, ty) = (t0c % gw, (t0c / gw) % gh);
            let h = |c: usize| -> u32 {
                let x = c % gw;
                let y = (c / gw) % gh;
                ((x as isize - tx as isize).abs() + (y as isize - ty as isize).abs()) as u32
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
                if expansions > 2_500_000 {
                    break;
                }
                let x = c % gw;
                let y = (c / gw) % gh;
                let l = c / (gw * gh);
                let mut push = |nc: usize, cost: u32,
                                dist: &mut HashMap<usize, u32>,
                                prev: &mut HashMap<usize, usize>,
                                heap: &mut BinaryHeap<std::cmp::Reverse<(u32, usize)>>| {
                    let o = owner[nc];
                    if o != 0 && o != nid {
                        return;
                    }
                    let ng = g + cost;
                    if ng < *dist.get(&nc).unwrap_or(&u32::MAX) {
                        dist.insert(nc, ng);
                        prev.insert(nc, c);
                        heap.push(std::cmp::Reverse((ng + h(nc), nc)));
                    }
                };
                let step: u32 = if l + 1 == nl { 3 } else { 1 }; // B.Cu penalty
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
                    let via_ok = (0..nl).all(|ll| {
                        for dy in -via_keep..=via_keep {
                            for dx in -via_keep..=via_keep {
                                let nx = x as isize + dx;
                                let ny = y as isize + dy;
                                if nx < 0 || ny < 0 || nx >= gw as isize || ny >= gh as isize {
                                    return false;
                                }
                                let o = owner[idx(nx as usize, ny as usize, ll)];
                                if o != 0 && o != nid {
                                    return false;
                                }
                            }
                        }
                        true
                    });
                    if via_ok {
                        for ll in 0..nl {
                            if ll != l {
                                push(idx(x, y, ll), via_cost, &mut dist, &mut prev, &mut heap);
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
                        owner[c] = nid;
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
                                // claim the via keepout on all layers
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
                                                let cc =
                                                    idx(nx as usize, ny as usize, ll);
                                                if owner[cc] == 0 {
                                                    owner[cc] = nid;
                                                }
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
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            routed_nets += 1;
            results.push(Routed {
                name: net.name.clone(),
                paths: net_paths,
                vias: net_vias,
            });
        } else if !is_retry {
            retry.push((ni, attempt + 1));
        } else {
            failed_nets += 1;
            if failed_names.len() < 20 {
                failed_names.push(net.name.clone());
            }
        }
    }

    // ---------- emit SES -------------------------------------------------------------
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
