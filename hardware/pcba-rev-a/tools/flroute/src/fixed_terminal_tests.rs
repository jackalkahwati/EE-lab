use super::*;

fn layers() -> Vec<String> { vec!["F.Cu".into(), "B.Cu".into()] }

fn scl_entry() -> FixedEntry {
    FixedEntry { cell: 59 * 44 + 23 * 59 + 37, via: FixedVia {
        net: "SCL".into(), x: 15625.0, y: -7975.0, radius: 300.0,
        drill_radius: 150.0, fixed: true } }
}

#[test]
fn actual_scl_serialized_endpoint_emits_same_layer_exact_center_connector() {
    let e = scl_entry();
    // Actual retained SES had 155424, not ideal-grid155425: preserve its
    // truncation exactly so the short connector and existing route coincide.
    let c = fixed_center_connector(&e, e.cell, "SCL", true, (155424,-80925), 10.0, 200.0).unwrap();
    assert_eq!(c, [(155424,-80925), (156250,-79750)]);
    let text = center_connector_ses("B.Cu", 2000, c);
    assert_eq!(text, "        (wire (path B.Cu 2000 155424 -80925 156250 -79750))\n");
    let sx = parse_sx(&text);
    let path = sx.kid("path").unwrap();
    assert_eq!(path.list()[1].sym(), "B.Cu");
    assert_eq!((path.num(5),path.num(6)), (e.via.x*10.0,e.via.y*10.0));
    // Official KiCad10.0.5 connectivity checker lines221-252 exempts the
    // off-center original track when a connected SAME-LAYER track has an
    // endpoint exactly at viaPos. This asserts that precise emitted contract,
    // not a native DRC pass or a source-level ignored-check workaround.
    let p = (c[0].0 as f64/10.0,c[0].1 as f64/10.0);
    let reach = (p.0-e.via.x).hypot(p.1-e.via.y)+100.0;
    assert!(reach < 299.0 && reach > 151.0);
}

#[test]
fn unused_wrong_net_wrong_layer_and_zero_length_entries_emit_no_connector() {
    let e = scl_entry();
    for (cell,net,used,p) in [
        (e.cell,"SCL",false,(155424,-80925)),
        (e.cell,"SDA",true,(155424,-80925)),
        (e.cell-59*44,"SCL",true,(155424,-80925)),
        (e.cell,"SCL",true,(156250,-79750)),
    ] {
        assert!(fixed_center_connector(&e,cell,net,used,p,10.0,200.0).is_none());
    }
    let c = fixed_center_connector(&e,e.cell,"SCL",true,(155424,-80925),10.0,200.0).unwrap();
    let mut dedup = HashSet::new();
    assert!(dedup.insert((1,c)));
    assert!(!dedup.insert((1,c)), "junction repeated by two paths is emitted only once");
}

#[test]
fn center_connector_rejects_unrepresentable_center_or_cap_outside_land() {
    let mut e = scl_entry();
    e.via.x += 0.025;
    assert!(fixed_center_connector(&e,e.cell,"SCL",true,(155424,-80925),10.0,200.0).is_none());
    let e = scl_entry();
    assert!(fixed_center_connector(&e,e.cell,"SCL",true,(150000,-80925),10.0,200.0).is_none());
}

#[test]
fn connector_whole_segment_foreign_copper_gate_rejects_obstacle() {
    let e = scl_entry();
    let c = fixed_center_connector(&e,e.cell,"SCL",true,(155424,-80925),10.0,200.0).unwrap();
    let a = (c[0].0 as f64/10.0,c[0].1 as f64/10.0);
    let b = (c[1].0 as f64/10.0,c[1].1 as f64/10.0);
    let mut copper = FixedCopper { wires: Vec::new(), vias: vec![e.via.clone()] };
    assert!(fixed_segment_clear(a,b,1,"SCL",200.0,150.0,&copper,&HashMap::new(),&HashMap::new(),1));
    copper.wires.push(FixedWire { net:"GND".into(),layer:1,width:200.0,fixed:true,
        pts:vec![(15500.0,-8030.0),(15700.0,-8030.0)] });
    assert!(!fixed_segment_clear(a,b,1,"SCL",200.0,150.0,&copper,&HashMap::new(),&HashMap::new(),1));
}


#[test]
fn authentic_native_parser_header_keeps_library_and_wiring_visible() {
    let header = r#"(pcb "/Volumes/T9 Backup/owned/board.dsn"
      (parser
        (string_quote ")
        (space_in_quoted_tokens on)
        (host_cad "KiCad's Pcbnew")
        (host_version "10.0.1"))"#;
    let text = fixture().replacen("(pcb test", header, 1);
    let root = parse_sx(&text);
    assert_eq!(root.tag(), "pcb");
    assert!(root.kid("library").is_some());
    let c = read_fixed_copper(&root, &layers()).expect("native wiring visible");
    assert_eq!(connected_fixed_vias(&pin(), "SDA", &c).len(), 1);
}

#[test]
fn generated_via_cannot_duplicate_or_overlap_fixed_via_even_same_net() {
    let c = copper(&fixture());
    assert!(!clears_existing_vias(14325.0, -7175.0, 300.0, 150.0, &c));
    assert!(!clears_existing_vias(14335.0, -7287.5, 300.0, 150.0, &c));
    assert!(!clears_existing_vias(14325.0 + 749.0, -7175.0, 300.0, 150.0, &c));
    assert!(clears_existing_vias(14325.0 + 750.0, -7175.0, 300.0, 150.0, &c));
}

// Native KiCad units/sign convention and U1.3 geometry, without routing a board.
fn fixture() -> String {
    r#"(pcb test (resolution um 10) (unit um)
      (library
        (padstack Rect (shape (rect F.Cu -250 -175 250 175)) (attach off))
        (padstack "Via[0-1]_600:300_um"
          (shape (circle F.Cu 600)) (shape (circle B.Cu 600)) (attach off)))
      (wiring
        (wire (path F.Cu 200 14325 -7975 14325 -7175) (net SDA) (type fix))
        (via "Via[0-1]_600:300_um" 14325 -7175 (net SDA) (type fix))))"#.into()
}

fn pin() -> AbsPin {
    AbsPin { x: 14325.0, y: -7975.0,
        pad: PadInfo { hw: 175.0, hh: 250.0, ox: 0.0, oy: 0.0, layers: 1, circle: false },
        fixed_seed_rect: true }
}

fn copper(text: &str) -> FixedCopper { read_fixed_copper(&parse_sx(text), &layers()).unwrap() }

#[test]
fn native_offgrid_pad_wire_via_is_connected_on_back_layer() {
    let c = copper(&fixture());
    let p = pin();
    let vias = connected_fixed_vias(&p, "SDA", &c);
    assert_eq!(vias.len(), 1);
    assert_eq!(c.wires[0].layer, 0);
    assert_eq!(p.pad.layers, 1, "original SMD pad stays front-only");
    let pitch = (200.0 + 150.0) * 1.15;
    let x = 650.0 + ((14325.0_f64 - 650.0) / pitch).round() * pitch;
    let y = -17350.0 + ((-7175.0_f64 + 17350.0) / pitch).round() * pitch;
    assert!((x - 14335.0).abs() < 1e-8);
    assert!((y + 7287.5).abs() < 1e-8);
    assert!(((x - 14325.0).hypot(y + 7175.0) - 112.943569).abs() < 0.001);
    assert!(via_contains_cap(vias[0], x, y, 200.0));
    assert!(fixed_segment_clear((x,y), (x + pitch,y), 1, "SDA", 200.0, 150.0,
        &c, &HashMap::new(), &HashMap::new(), 1));
}

#[test]
fn rejects_wrong_net_wire_or_via() {
    let base = fixture();
    for text in [base.replacen("(net SDA)", "(net GND)", 1),
        base.replace("-7175 (net SDA)", "-7175 (net GND)")] {
        assert!(connected_fixed_vias(&pin(), "SDA", &copper(&text)).is_empty());
    }
}

#[test]
fn disconnected_same_net_and_clearance_halo_are_not_connectivity() {
    let base = fixture();
    let island = base.replace("14325 -7975 14325 -7175", "15125 -7975 15125 -7175")
        .replace("14325 -7175 (net SDA)", "15125 -7175 (net SDA)");
    assert!(connected_fixed_vias(&pin(), "SDA", &copper(&island)).is_empty());
    // Trace cap starts 10um beyond actual pad edge, though inside its halo.
    let halo = base.replace("14325 -7975 14325 -7175", "14610 -7975 14325 -7175");
    assert!(connected_fixed_vias(&pin(), "SDA", &copper(&halo)).is_empty());
    let gap = base.replace("14325 -7175 (net SDA)", "14735 -7175 (net SDA)");
    assert!(connected_fixed_vias(&pin(), "SDA", &copper(&gap)).is_empty());
}

#[test]
fn same_xy_other_layer_wire_cannot_connect_smd_pad() {
    let text = fixture().replace("(path F.Cu", "(path B.Cu");
    assert!(connected_fixed_vias(&pin(), "SDA", &copper(&text)).is_empty());
}

#[test]
fn only_fixed_single_straight_wire_pattern_is_promoted() {
    let base = fixture();
    for text in [base.replace("type fix", "type route"),
        base.replace("14325 -7975 14325 -7175", "14325 -7975 14325 -7575 14325 -7175")] {
        assert!(connected_fixed_vias(&pin(), "SDA", &copper(&text)).is_empty());
    }
    let mut p = pin();
    p.fixed_seed_rect = false;
    assert!(connected_fixed_vias(&p, "SDA", &copper(&base)).is_empty());
}

#[test]
fn nonplated_missing_layer_mismatched_circle_and_unknown_name_fail_closed() {
    let base = fixture();
    for text in [
        base.replace("(attach off)))", "(plated off) (attach off)))"),
        base.replace("(shape (circle B.Cu 600))", ""),
        base.replace("(circle B.Cu 600)", "(circle B.Cu 601)"),
        base.replace("(circle B.Cu 600)", "(circle unknown 600)"),
        base.replace("(circle B.Cu 600)", "(rect B.Cu -300 -300 300 300)"),
        base.replace("Via[0-1]_600:300_um", "Via[0-0]_600:300_um"),
        base.replace("Via[0-1]_600:300_um", "Via[0-1]_bad:300_um"),
        base.replace("Via[0-1]_600:300_um", "Via[0-1]_600:600_um"),
        base.replace("Via[0-1]_600:300_um", "Via[0-1]_600:0_um"),
        base.replace("Via[0-1]_600:300_um", "arbitrary"),
        base.replace("(circle B.Cu 600)", "(circle B.Cu 600 1 0)"),
        base.replace("(path F.Cu 200", "(path unknown 200"),
        base.replace("(path F.Cu 200", "(path F.Cu NaN"),
    ] {
        assert!(read_fixed_copper(&parse_sx(&text), &layers()).is_none(), "accepted {text}");
    }
}

#[test]
fn cap_must_fit_outer_circle_and_overlap_annulus_not_hole_or_tangent() {
    let c = copper(&fixture());
    let v = &c.vias[0];
    assert!(!via_contains_cap(v, v.x + 250.0, v.y, 200.0)); // halo-only
    assert!(!via_contains_cap(v, v.x, v.y, 200.0)); // cap wholly in hole
    assert!(!via_contains_cap(v, v.x + 50.0, v.y, 200.0)); // inner tangent
    assert!(!via_contains_cap(v, v.x + 200.0, v.y, 200.0)); // outer tangent
    assert!(via_contains_cap(v, v.x + 100.0, v.y, 200.0));
}

#[test]
fn exact_segment_gate_checks_foreign_fixed_wire_via_and_pad_not_only_endpoints() {
    let mut c = copper(&fixture());
    let a = (14335.0, -7287.5);
    let b = (15140.0, -7287.5);
    let check = |c: &FixedCopper, pins: &HashMap<String, AbsPin>| fixed_segment_clear(
        a, b, 1, "SDA", 200.0, 150.0, c, pins, &HashMap::new(), 1);
    c.wires.push(FixedWire { net: "GND".into(), layer: 1, width: 200.0,
        pts: vec![(14737.5,-7600.0), (14737.5,-7000.0)], fixed: true });
    assert!(!check(&c, &HashMap::new()));
    c.wires.last_mut().unwrap().layer = 0;
    assert!(check(&c, &HashMap::new())); // no cross-layer copper shortcut
    c.vias.push(FixedVia { net: "GND".into(), x: 14737.5, y: -7287.5,
        radius: 300.0, drill_radius: 150.0, fixed: true });
    assert!(!check(&c, &HashMap::new()));
    c.vias.pop();
    let mut p = pin(); p.x = 14737.5; p.y = -7287.5; p.pad.layers = 2;
    let pins = HashMap::from([("foreign".into(), p)]);
    assert!(!check(&c, &pins));
}

#[test]
fn short_parallel_segment_box_distance_includes_endpoint_to_edge() {
    assert_eq!(seg_box_dist(4.0, 12.0, 6.0, 12.0, 0.0, 0.0, 10.0, 10.0), 2.0);
    assert_eq!(seg_box_dist(12.0, 4.0, 12.0, 6.0, 0.0, 0.0, 10.0, 10.0), 2.0);
    assert_eq!(seg_box_dist(4.0, 4.0, 6.0, 6.0, 0.0, 0.0, 10.0, 10.0), 0.0);
    assert_eq!(seg_box_dist(-1.0, 5.0, 11.0, 5.0, 0.0, 0.0, 10.0, 10.0), 0.0);
}

#[test]
fn exact_rectangle_proof_does_not_accept_rounded_bbox_or_multilayer_shape() {
    let root = parse_sx(&fixture());
    let rect = root.kid("library").unwrap().kids("padstack").next().unwrap();
    assert!(fixed_rect_stack(rect, &layers()));
    for text in ["(padstack p (shape (polygon F.Cu 0 -250 -175 250 175)))",
        "(padstack p (shape (rect signal -250 -175 250 175)))",
        "(padstack p (shape (rect F.Cu -250 -175 250 175)) (shape (rect B.Cu -250 -175 250 175)))"] {
        assert!(!fixed_rect_stack(&parse_sx(text), &layers()));
    }
}
