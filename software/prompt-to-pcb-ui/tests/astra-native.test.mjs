import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const adapter = fileURLToPath(new URL('../scripts/astra-native.py', import.meta.url))

// Ordinary system Python only. No pcbnew import or native executable is permitted.
const suite = String.raw`
import copy
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("astra_native", sys.argv[1])
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class NativeContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.project={'board':{'design_settings':{'rule_severities':dict.fromkeys(a.ENABLED_DEFAULT_CHECKS,'error'),
            'drc_exclusions':[],'rules':{'min_resolved_spokes':2}}}}
        for name in ('board','imported-board','final-board'):
            (self.root/(name+'.kicad_pro')).write_text(json.dumps(self.project))
        catalog = {}
        for cid, (library, name) in a.FOOTPRINTS.items():
            lib = self.root / library
            lib.mkdir()
            fp = lib / (name + '.kicad_mod')
            fp.write_text('mock footprint ' + cid)
            model = self.root / (name + '.step')
            model.write_text('mock STEP ' + cid)
            catalog[cid] = {
                'footprint': {'libraryPath': str(lib), 'name': name, 'sha256': a.digest(fp)},
                'padNumbers': [str(n) for n in range(1, 9 if cid == 'bme280' else 5 if cid == 'header-1x04' else 3)],
                'models': [{'path': str(model), 'sha256': a.digest(model),
                    'sourceReference': '$' + '{KICAD10_3DMODEL_DIR}/' + library.replace('.pretty', '.3dshapes') + '/' + name + '.step',
                    'offsetMm': [0.01500000025,-0.03500000059,0] if cid == 'bme280' else [0,0,0],
                    'scale': [1,1,1], 'rotationDeg': [0,0,0]}]}
        self.data = {'version': 1, 'board': a.BOARD.copy(), 'assetRoots': [str(self.root)],
            'parts': [{'ref': ref, 'catalogId': cid} for ref,cid in a.PARTS.items()], 'catalog': catalog,
            'nets': [{'name': name, 'pins': [dict(zip(('ref','pad'), endpoint.split('.'))) for endpoint in sorted(pins)]}
                for name,pins in a.NETS.items()]}
        (self.root/'fp-lib-table').write_text(a.footprint_table(self.data))

    def rejected(self, mutate, pattern):
        data = copy.deepcopy(self.data)
        mutate(data)
        with self.assertRaisesRegex(a.NativeError, pattern):
            a.validate_input(data)

    def test_import_is_non_native(self):
        self.assertNotIn('pcbnew', sys.modules)
        self.assertEqual(a.validate_input(self.data), self.data)

    def test_reviewed_catalog_interface(self):
        catalog=json.loads((pathlib.Path(sys.argv[1]).parent.parent/'lib'/'astra-catalog.json').read_text())
        self.assertEqual(a.VALUES,{ref:p['value'] for ref,p in catalog['parts'].items()})
        self.assertEqual(a.PARTS,{ref:p['catalogId'] for ref,p in catalog['parts'].items()})
        for ref,p in catalog['parts'].items():
            self.assertEqual(catalog['assets'][p['catalogId']]['footprint']['name'],a.FOOTPRINTS[p['catalogId']][1])

    def test_catalog_and_ref_allowlists(self):
        self.rejected(lambda d: d['parts'].pop(), 'six reviewed')
        self.rejected(lambda d: d['parts'][0].update(catalogId='header-1x04'), 'substituted')
        self.rejected(lambda d: d['parts'][1].update(ref='U1', catalogId='bme280'), 'duplicate')
        self.rejected(lambda d: d['parts'][0].update(value='TMP112'), 'value substitution')
        self.rejected(lambda d: d.update(code='run me'), 'unexpected native')
        self.rejected(lambda d: d['catalog']['bme280']['footprint'].update(name='approximate-body'), 'footprint identity')
        self.rejected(lambda d: d['catalog']['bme280'].update(padNumbers=['1','2']), 'pad numbers')

    def test_exact_topology_no_missing_pins_or_shorts(self):
        for net_index in range(4):
            with self.subTest(net=net_index):
                self.rejected(lambda d: d['nets'][net_index]['pins'].pop(), 'topology mismatch')
        self.rejected(lambda d: d['nets'][0]['pins'].append({'ref':'U1','pad':'1'}), 'topology mismatch')
        self.rejected(lambda d: d['nets'][0]['pins'].append(d['nets'][0]['pins'][0]), 'topology mismatch')
        self.rejected(lambda d: d['nets'][3].update(name='SDA'), 'duplicate canonical')
        self.rejected(lambda d: d['nets'][2]['pins'][0].update(pad='4'), 'topology mismatch')

    def test_placement_layer_and_board_contract(self):
        self.rejected(lambda d: d['board'].update(layers=4), 'two-layer')
        self.rejected(lambda d: d['board'].update(widthMm=30), 'two-layer')
        self.data['placement'] = [{'ref': ref, 'xMm': p[0], 'yMm': p[1], 'rotationDeg': p[2]} for ref,p in a.PLACEMENT.items()]
        a.validate_input(self.data)
        self.rejected(lambda d: d['placement'][0].update(xMm=10), 'deterministic')
        self.rejected(lambda d: d['placement'][2].update(rotationDeg=90), 'deterministic')

    def test_models_require_matching_hash_and_transform(self):
        self.rejected(lambda d: d['catalog']['bme280']['models'][0].update(offsetMm=[0,0,0]), 'offset differs')
        self.rejected(lambda d: d['catalog']['bme280']['models'][0].update(scale=[1,2,1]), 'scale differs')
        self.rejected(lambda d: d['catalog']['bme280']['models'][0].update(rotationDeg=[0,0,float('nan')]), 'rotation invalid')
        self.rejected(lambda d: d['catalog']['bme280']['models'][0].update(sha256='0'*64), 'asset hash mismatch')
        self.rejected(lambda d: d['catalog']['bme280']['models'][0].update(sourceReference='remote.step'), 'source model')
        self.rejected(lambda d: d['catalog']['bme280'].update(models=[]), 'one exact STEP')

    def test_asset_boundary_and_symlinks(self):
        sub = self.root/'narrow'
        sub.mkdir()
        self.rejected(lambda d: d.update(assetRoots=[str(sub)]), 'outside reviewed')
        model = pathlib.Path(self.data['catalog']['bme280']['models'][0]['path'])
        original = model.with_suffix('.original')
        model.rename(original)
        model.symlink_to(original)
        with self.assertRaisesRegex(a.NativeError, 'symlink'):
            a.validate_input(self.data)
        with self.assertRaisesRegex(a.NativeError, 'absolute'):
            a.no_links('relative.step')

    def test_json_duplicates_nonfinite_and_output_collision(self):
        path = self.root/'input.json'
        path.write_text('{"version":1,"version":2}')
        with self.assertRaisesRegex(a.NativeError, 'duplicate JSON'):
            a.read_json(path)
        path.write_text('{"x":NaN}')
        with self.assertRaisesRegex(a.NativeError, 'nonfinite'):
            a.read_json(path)
        path.unlink()
        a.write_json(path, {'result':'first'})
        with self.assertRaises(FileExistsError):
            a.write_json(path, {'result':'replaced'})

    def test_dsn_inset_only_changes_boundary(self):
        text = '(pcb test (resolution um 10) (boundary (path pcb 0 24000 0 0 0 0 -18000 24000 -18000 24000 0)) (network (net "GND" (pins U1-1 C1-2))))'
        result = a.inset_dsn(text)
        self.assertIn('23350 -17350 650 -17350 650 -650 23350 -650', result)
        self.assertTrue(result.endswith('(network (net "GND" (pins U1-1 C1-2))))'))
        for bad in (text.replace('um 10','mm 1000'), text.replace('24000','25000'), text.replace('0 -18000','500 -18000'), '(pcb no_boundary)'):
            with self.assertRaises(a.NativeError):
                a.inset_dsn(bad)

    def test_identity_detects_geometry_and_model_mutations(self):
        # Deliberately non-square rotated pads, nonzero model offset and roundrect.
        v = lambda x,y,z=0: types.SimpleNamespace(x=x,y=y,z=z)
        model = types.SimpleNamespace(m_Filename='/owned/BME.step',m_Offset=v(.015,-.035),m_Scale=v(1,1,1),
            m_Rotation=v(0,0),m_Show=True,m_Opacity=1)
        pad = types.SimpleNamespace(GetNumber=lambda:'1',GetNetname=lambda:'GND',GetPosition=lambda:v(13025000,7975000),
            GetSize=lambda:v(500000,350000),GetOffset=lambda:v(0,0),GetOrientationDegrees=lambda:90,
            GetShape=lambda:2,GetAttribute=lambda:1,GetLayerSet=lambda:types.SimpleNamespace(Seq=lambda:[0,35,39]),
            GetDrillSize=lambda:v(0,0),GetDrillShape=lambda:0,GetRoundRectRadiusRatio=lambda:.25)
        fp = types.SimpleNamespace(Pads=lambda:[pad],GetReference=lambda:'U1',GetValue=lambda:'BME280',
            GetFPIDAsString=lambda:'Package_LGA:Bosch_LGA',GetPosition=lambda:v(14000000,9000000),
            GetOrientationDegrees=lambda:0,GetLayer=lambda:0,Models=lambda:[model])
        board = types.SimpleNamespace(GetFootprints=lambda:[fp],GetCopperLayerCount=lambda:2)
        original = a.identity(board)
        self.assertEqual(original['footprints'][0]['pads'][0]['rotationDeg'],90)
        self.assertEqual(original['footprints'][0]['models'][0]['offsetMm'],[.015,-.035,0])
        for field,value in [('rotationDeg',0),('net','3V3'),('shape',1),('roundrectRatio',0),('sizeNm',[500000,500000])]:
            changed = copy.deepcopy(original)
            changed['footprints'][0]['pads'][0][field] = value
            with self.assertRaisesRegex(a.NativeError,'identity changed'):
                a.assert_identity(original,changed)
        model.m_Offset.x = 0
        with self.assertRaisesRegex(a.NativeError,'identity changed'):
            a.assert_identity(original,a.identity(board))

    def test_close_decouplers_use_native_centers_and_ground_layer(self):
        coordinates={'C1.1':(12.7,11.12),'C1.2':(12.7,12.08),'U1.8':(13.025,10.025),
            'C2.1':(14.7,11.12),'C2.2':(14.7,12.08),'U1.6':(14.325,10.025)}
        back=set()
        def pad(endpoint):
            return types.SimpleNamespace(GetNumber=lambda:endpoint.split('.')[1],
                IsOnLayer=lambda layer:endpoint not in back,
                GetPosition=lambda:types.SimpleNamespace(x=coordinates[endpoint][0]*1e6,y=coordinates[endpoint][1]*1e6))
        fps=[types.SimpleNamespace(GetReference=lambda ref=ref:ref,
            Pads=lambda ref=ref:[pad(e) for e in coordinates if e.startswith(ref+'.')]) for ref in ('C1','C2','U1')]
        board=types.SimpleNamespace(GetFootprints=lambda:fps)
        pcb=types.SimpleNamespace(F_Cu=0)
        self.assertTrue(all(x['distanceMm']<1.2 for x in a.close_decouplers(board,pcb)))
        coordinates['C1.1']=(0,0)
        with self.assertRaisesRegex(a.NativeError,'exceeds 2mm'):
            a.close_decouplers(board,pcb)
        coordinates['C1.1']=(12.7,11.12)
        back.add('C1.2')
        with self.assertRaisesRegex(a.NativeError,'front copper'):
            a.close_decouplers(board,pcb)

    def test_ground_candidates_are_finite_deterministic_and_never_in_pad(self):
        points=a.ground_candidates((13025000,7975000))
        self.assertEqual(points,a.ground_candidates((13025000,7975000)))
        self.assertEqual(len(points),240)
        self.assertEqual(len(set(points)),240)
        self.assertNotIn((13025000,7975000),points)
        self.assertTrue(all(399998 <= a.math.hypot(x-13025000,y-7975000) <= 2600002 for x,y in points))

    def test_ground_graph_anchors_j1_not_largest_or_whole_zone(self):
        # Every polygon is a separate node, although all front polygons belong
        # to ONE ZONE. The biggest pad cluster is deliberately not J1.2's.
        pads={name:object() for name in sorted(a.NETS['GND'])}
        nodes={name:{} for name in pads}
        nodes.update({'front-0':{},'front-1':{},'back-0':{}})
        links=[('J1.2','front-0'),('J1.2','back-0'),('C1.2','front-1'),('C2.2','front-1'),
               ('U1.1','front-1'),('U1.5','front-1')]
        components=a.connected_components(nodes,links)
        anchor=next(c for c in components if 'J1.2' in c)
        self.assertEqual(anchor,{'J1.2','front-0','back-0'})
        self.assertNotIn('U1.7',anchor)
        self.assertEqual(len(components),3)
        self.assertEqual(components,a.connected_components(dict(reversed(list(nodes.items()))),list(reversed(links))))
        with self.assertRaisesRegex(a.NativeError,'unknown ground graph'):
            a.connected_components(nodes,[('J1.2','missing')])

    def test_ground_geometry_checks_whole_stub_both_layers_and_drills(self):
        calls=[]
        class Shape:
            def __init__(self,name): self.name=name
            def Collide(self,other,gap=0):
                calls.append((self.name,other.name,gap))
                return (self.name,other.name,gap) in blocked
            def BBox(self):
                return types.SimpleNamespace(GetLeft=lambda:1000000,GetRight=lambda:2000000,
                    GetTop=lambda:1000000,GetBottom=lambda:2000000)
        blocked=set()
        guard=object.__new__(a.GroundClearance)
        guard.pcbnew=types.SimpleNamespace(SHAPE_POLY_SET=type('Poly',(),{}),
            SHAPE=types.SimpleNamespace(Collide=lambda left,right,gap:left.Collide(right,gap)))
        guard.clearance=150000;guard.hole_clearance=250000;guard.edge_clearance=500000
        guard.width=24000000;guard.height=18000000
        guard.layers=(0,2)
        guard.other={0:[Shape('front')],2:[Shape('back')]}
        guard.holes=[(Shape('other-hole'),False),(Shape('own-hole'),True)]
        guard.pads=[Shape('source-pad')]
        guard.added_holes=[]
        stub=Shape('whole-stub');land=Shape('land');drill=Shape('drill')
        self.assertIsNone(guard.reject(stub,0,land,drill))
        expected={('front','whole-stub',150000),('front','land',150000),('back','land',150000),
            ('front','drill',250000),('back','drill',250000),('other-hole','whole-stub',250000),
            ('other-hole','land',250000),('other-hole','drill',250000),('own-hole','drill',250000),
            ('source-pad','land',0)}
        self.assertTrue(expected.issubset(set(calls)))
        for hit in expected:
            blocked={hit}
            self.assertIsNotNone(guard.reject(stub,0,land,drill),hit)
        blocked=set()
        guard.added_holes=[Shape('previous-via')]
        blocked={('previous-via','drill',250000)}
        self.assertEqual(guard.reject(stub,0,land,drill),'hole-spacing')
        blocked=set()
        stub.BBox=lambda:types.SimpleNamespace(GetLeft=lambda:499999,GetRight=lambda:2000000,
            GetTop=lambda:1000000,GetBottom=lambda:2000000)
        self.assertEqual(guard.reject(stub,0,land,drill),'board-edge')

    def test_no_legal_ground_candidate_rejects_before_any_board_edit(self):
        pad=types.SimpleNamespace(GetPosition=lambda:types.SimpleNamespace(x=13025000,y=7975000))
        board=types.SimpleNamespace(Add=lambda item:self.fail('must plan all stitches before mutation'))
        scene={'pads':{'J1.2':object(),'U1.1':pad},
            'components':[{'J1.2','back:0'},{'U1.1'}],
            'nodes':{'back:0':{2:object()}},'backNodes':{'back:0'}}
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,FromMM=lambda n:round(n*1e6),
            VECTOR2I=lambda x,y:(x,y),SHAPE_CIRCLE=lambda p,r:object(),SHAPE_SEGMENT=lambda p,q,w:object())
        guard=types.SimpleNamespace(reject=lambda *args:'other-copper',added_holes=[],corridor_boxes=lambda:[])
        with patch.object(a,'ground_scene',return_value=scene),patch.object(a,'GroundClearance',return_value=guard):
            with self.assertRaisesRegex(a.NativeError,'no legal GND fanout.*U1.1'):
                a.stitch_ground(board,pcb)

    def test_ground_scene_does_not_connect_separate_polygons_in_one_zone(self):
        # Only test dispatch/graph identity here, not a substitute DRC geometry.
        class Shape:
            def __init__(self,key,contacts=()): self.key=key;self.contacts=set(contacts)
            def Collide(self,other,gap=0): return other.key in self.contacts or self.key in other.contacts
        class Pad:
            def __init__(self,key): self.key=key
            def GetNumber(self): return self.key.split('.')[1]
            def GetNetname(self): return 'GND'
            def GetAttribute(self): return 0 if self.key=='J1.2' else 1
            def IsOnLayer(self,layer): return layer==0 or self.key=='J1.2'
            def GetEffectiveShape(self,layer): return Shape(self.key)
        class Polys:
            def __init__(self,shapes): self.shapes=shapes
            def OutlineCount(self): return len(self.shapes)
            def UnitSet(self,index): return self.shapes[index]
        front=Polys([Shape('front-anchor',['J1.2']),Shape('front-island',['C1.2','C2.2','U1.1','U1.5','U1.7'])])
        back=Polys([Shape('back',['J1.2'])])
        zones=[types.SimpleNamespace(GetLayer=lambda layer=layer:layer,GetNetname=lambda:'GND',IsFilled=lambda:True,
            HasFilledPolysForLayer=lambda layer:True,GetFilledPolysList=lambda layer,p=p:p) for layer,p in [(0,front),(2,back)]]
        fps=[types.SimpleNamespace(GetReference=lambda ref=ref:ref,
            Pads=lambda ref=ref:[Pad(e) for e in sorted(a.NETS['GND']) if e.startswith(ref+'.')]) for ref in ('J1','C1','C2','U1')]
        board=types.SimpleNamespace(GetFootprints=lambda:fps,GetTracks=lambda:[],Zones=lambda:zones)
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,PAD_ATTRIB_PTH=0,SHAPE_POLY_SET=type('Poly',(),{}),SHAPE=Shape)
        result=a.ground_reachability(board,pcb)
        self.assertTrue(result['available'])
        self.assertEqual(result['reachedPads'],['J1.2'])
        self.assertEqual(result['unreachedPads'],['C1.2','C2.2','U1.1','U1.5','U1.7'])
        self.assertEqual(len(result['padComponents']),2)
        zones[1].IsFilled=lambda:False
        self.assertFalse(a.ground_reachability(board,pcb)['available'])
        self.assertIsNone(a.ground_reachability(board,pcb)['unreachedPads'])

    def test_ground_plan_updates_holes_and_connectivity_before_next_candidate(self):
        v=lambda x,y:types.SimpleNamespace(x=x,y=y)
        class Shape:
            def __init__(self,kind,center): self.kind=kind;self.center=center
            def Collide(self,other,gap=0): return False
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,VIATYPE_THROUGH=3,
            SHAPE_POLY_SET=type('Poly',(),{}),SHAPE=Shape,
            VECTOR2I=v,SHAPE_CIRCLE=lambda p,r:Shape('circle',p),SHAPE_SEGMENT=lambda p,q,w:Shape('stub',q))
        pads={key:types.SimpleNamespace(GetPosition=lambda index=index:v(index*1000000,5000000))
            for index,key in enumerate(('J1.2','C1.2','U1.1'))}
        target=types.SimpleNamespace(Contains=lambda at:True,CollideEdge=lambda *args:False)
        nodes={key:{0:object()} for key in pads};nodes['zone:2:0']={2:target}
        scene={'pads':pads,'nodes':nodes,'backNodes':{'zone:2:0'},'components':[{'J1.2','zone:2:0'},{'C1.2'},{'U1.1'}]}
        checks=[]
        guard=types.SimpleNamespace(added_holes=[],corridor_boxes=lambda:[])
        guard.reject=lambda *args:checks.append(len(guard.added_holes)) or None
        mutations=[]
        def item(board):
            return types.SimpleNamespace(**{name:lambda *args:None for name in
                ('SetViaType','SetLayerPair','SetPosition','SetWidth','SetDrill','SetNet','SetStart','SetEnd','SetLayer')})
        pcb.PCB_VIA=item;pcb.PCB_TRACK=item
        board=types.SimpleNamespace(FindNet=lambda n:object(),GetTracks=lambda:[],Add=lambda item:mutations.append(item))
        def links(nodes,pcbnew):
            self.assertEqual(mutations,[]) # Whole plan before native mutations.
            out=[('J1.2','zone:2:0')]
            for index,endpoint in enumerate(('C1.2','U1.1')):
                key='stitch-via:'+str(index)
                if key in nodes: out += [(endpoint,key),(key,'zone:2:0'),(endpoint,'stitch-stub:'+str(index))]
            return out
        with patch.object(a,'ground_scene',return_value=scene),patch.object(a,'GroundClearance',return_value=guard), \
             patch.object(a,'ground_links',side_effect=links),patch.object(a,'plan_thermal_spokes',return_value=[]), \
             patch.object(a,'ground_candidates',side_effect=lambda c:[(c[0],c[1]+1000000)]):
            result=a.stitch_ground(board,pcb)
        self.assertEqual(checks,[0,1])
        self.assertEqual(len(mutations),4)
        self.assertEqual([p['pad'] for p in result['stitches']],['C1.2','U1.1'])
        self.assertEqual(result['connectivityVerdict'],'requires-fresh-saved-board-inspection')

    def test_ground_plan_rejects_unanchored_land_and_missing_graph_progress(self):
        pad=types.SimpleNamespace(GetPosition=lambda:types.SimpleNamespace(x=13025000,y=7975000))
        target=types.SimpleNamespace(Contains=lambda at:False,CollideEdge=lambda *args:False)
        nodes={'J1.2':{},'U1.1':{},'zone:2:0':{2:target}}
        scene={'pads':{'J1.2':object(),'U1.1':pad},'nodes':nodes,'backNodes':{'zone:2:0'},
               'components':[{'J1.2','zone:2:0'},{'U1.1'}]}
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,VECTOR2I=lambda x,y:(x,y),
            SHAPE_CIRCLE=lambda *args:object(),SHAPE_SEGMENT=lambda *args:object())
        board=types.SimpleNamespace(Add=lambda item:self.fail('no mutation on rejected plan'))
        guard=types.SimpleNamespace(reject=lambda *args:None,added_holes=[],corridor_boxes=lambda:[])
        with patch.object(a,'ground_scene',return_value=scene),patch.object(a,'GroundClearance',return_value=guard):
            with self.assertRaisesRegex(a.NativeError,'not-inside-anchored-back-plane'):
                a.stitch_ground(board,pcb)
            target.Contains=lambda at:True
            with patch.object(a,'ground_links',return_value=[('J1.2','zone:2:0')]):
                with self.assertRaisesRegex(a.NativeError,'did not connect measured component'):
                    a.stitch_ground(board,pcb)

    def test_ground_guard_missing_hole_geometry_fails_closed(self):
        pad=types.SimpleNamespace(GetNetname=lambda:'GND',GetDrillSize=lambda:types.SimpleNamespace(x=300000,y=300000),
            GetEffectiveHoleShape=lambda:None)
        board=types.SimpleNamespace(GetFootprints=lambda:[types.SimpleNamespace(Pads=lambda:[pad])],GetTracks=lambda:[])
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,PCB_VIA=type('Via',(),{}))
        with patch.object(a,'checked_ground_edges'),self.assertRaisesRegex(a.NativeError,'hole geometry unavailable'):
            a.GroundClearance(board,pcb)
        pad.GetEffectiveHoleShape=lambda:(_ for _ in ()).throw(RuntimeError('native hole API failed'))
        with patch.object(a,'checked_ground_edges'),self.assertRaisesRegex(RuntimeError,'native hole API failed'):
            a.GroundClearance(board,pcb)

    def test_ground_edges_reject_cutouts_and_nonrectangular_outlines(self):
        points=[(0,0),(24000000,0),(24000000,18000000),(0,18000000)]
        edges=[]
        for start,end in zip(points,points[1:]+points[:1]):
            edges.append(types.SimpleNamespace(GetLayer=lambda:44,GetShape=lambda:1,
                GetStart=lambda start=start:types.SimpleNamespace(x=start[0],y=start[1]),
                GetEnd=lambda end=end:types.SimpleNamespace(x=end[0],y=end[1])))
        board=types.SimpleNamespace(GetDrawings=lambda:edges,GetFootprints=lambda:[])
        pcb=types.SimpleNamespace(Edge_Cuts=44,SHAPE_T_SEGMENT=1)
        a.checked_ground_edges(board,pcb)
        edges[0].GetEnd=lambda:types.SimpleNamespace(x=23000000,y=0)
        with self.assertRaisesRegex(a.NativeError,'edges changed'):
            a.checked_ground_edges(board,pcb)
        edges[0].GetEnd=lambda:types.SimpleNamespace(x=24000000,y=0)
        board.GetFootprints=lambda:[types.SimpleNamespace(GraphicalItems=lambda:[edges[0]])]
        with self.assertRaisesRegex(a.NativeError,'footprint board cutout'):
            a.checked_ground_edges(board,pcb)

    def test_ground_fill_is_measure_plan_final_fill_once_not_retry(self):
        events=[];zones=[]
        class Zone:
            def __init__(self,board): self.layer=None
            def SetLayer(self,layer): self.layer=layer
            def Outline(self): return types.SimpleNamespace(NewOutline=lambda:None,Append=lambda *args:None)
            def IsFilled(self): return True
            def GetFilledArea(self): return 100
        for name in ('SetNet','SetLocalClearance','SetMinThickness','SetPadConnection','SetThermalReliefGap','SetThermalReliefSpokeWidth'):
            setattr(Zone,name,lambda self,value:None)
        board=types.SimpleNamespace(Zones=lambda:zones,FindNet=lambda n:types.SimpleNamespace(GetNetCode=lambda:2),
            Add=lambda zone:zones.append(zone),BuildConnectivity=lambda:events.append('build'))
        filler=types.SimpleNamespace(Fill=lambda z:events.append('fill'))
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,ZONE=Zone,FromMM=lambda n:round(n*1e6),
            ZONE_CONNECTION_THERMAL=1,ZONE_FILLER=lambda b:filler)
        with patch.object(a,'stitch_ground',side_effect=lambda *args:events.append('stitch') or {'version':1}):
            result=a.fill_ground(board,pcb)
        self.assertEqual(events,['build','fill','stitch','build','fill'])
        self.assertEqual(result,{'version':1})
        events.clear();zones.clear()
        with patch.object(a,'stitch_ground',side_effect=a.NativeError('no legal path')):
            with self.assertRaisesRegex(a.NativeError,'no legal path'):
                a.fill_ground(board,pcb)
        self.assertEqual(events,['build','fill'])

    def test_exact_thermal_crossings_reject_tangencies_and_overlaps(self):
        square=[(0,0),(10,0),(10,10),(0,10)]
        band=[(-2,3),(12,4),(12,6),(-2,7)]
        crossings=a.strict_crossings(square,band)
        self.assertEqual(len(crossings),4)
        self.assertIn((a.Fraction(0),a.Fraction(22,7)),crossings)
        self.assertEqual(crossings,a.strict_crossings(list(reversed(square)),list(reversed(band))))
        for other in ([(-1,-1),(0,0),(-1,1)],[(-1,0),(11,0),(11,-1),(-1,-1)]):
            with self.assertRaisesRegex(a.NativeError,'ambiguous'):
                a.strict_crossings(square,other)
        self.assertEqual(a.line_boundary_crossings((5,5),(15,7),square),[(a.Fraction(10),a.Fraction(6))])
        self.assertEqual(a.line_boundary_crossings((5,5),(15,15),square),[])

    def test_thermal_measurement_counts_holes_not_just_outer_bbox(self):
        class Chain:
            def __init__(self,points): self.points=points
            def ArcCount(self): return 0
            def PointCount(self): return len(self.points)
            def CPoint(self,i): return types.SimpleNamespace(x=self.points[i][0],y=self.points[i][1])
        class Poly:
            def __init__(self,outer,holes=()): self.outer=outer;self.holes=holes
            def OutlineCount(self): return 1
            def HoleCount(self,index): return len(self.holes)
            def COutline(self,index): return Chain(self.outer)
            def CHole(self,index,hole): return Chain(self.holes[hole])
        boundary=Poly([(0,0),(10,0),(10,10),(0,10)])
        fill=Poly([(-20,-20),(20,-20),(20,20),(-20,20)],[[(-2,3),(12,4),(12,6),(-2,7)]])
        pad=types.SimpleNamespace(TransformShapeToPolygon=lambda *args:None)
        pcb=types.SimpleNamespace(F_Cu=0,SHAPE_POLY_SET=lambda:boundary,FromMM=lambda n:n,ARC_LOW_DEF_MM=.005,ERROR_OUTSIDE=1)
        scene={'nodes':{'zone:0:0':{0:fill}},'pads':{'C1.2':pad}}
        self.assertEqual(a.thermal_measurements(scene,pcb)['C1.2']['geometricSpokes'],2)
        fill.holes=[]
        self.assertEqual(a.thermal_measurements(scene,pcb)['C1.2']['geometricSpokes'],0)

    def test_supplemental_spoke_for_each_deficient_pad_even_shared_component(self):
        v=lambda x,y:types.SimpleNamespace(x=x,y=y)
        class Boundary:
            def __init__(self,x): self.x=x
            def Collide(self,*args): return False
            def COutline(self,index): return self.x
        class Poly:
            def Contains(self,at): return True
            def CollideEdge(self,*args): return False
            def Collide(self,*args): return False
        pads={key:types.SimpleNamespace(GetPosition=lambda x=x:v(x,5000000))
            for key,x in [('J1.2',1000000),('C1.2',3000000),('C2.2',5000000)]}
        nodes={key:{0:object()} for key in pads};nodes['zone:0:0']={0:Poly()}
        scene={'nodes':nodes,'pads':pads}
        measured={key:{'geometricSpokes':3 if key=='J1.2' else 1,'boundary':Boundary(pad.GetPosition().x)}
                  for key,pad in pads.items()}
        pcb=types.SimpleNamespace(F_Cu=0,VECTOR2I=v,SHAPE_SEGMENT=lambda *args:object(),SHAPE_CIRCLE=lambda *args:object())
        guard=types.SimpleNamespace(stub_clear=lambda *args:True)
        def contour(x):return [(x-200000,4800000),(x+200000,4800000),(x+200000,5200000),(x-200000,5200000)]
        with patch.object(a,'thermal_measurements',return_value=measured), \
             patch.object(a,'ground_links',return_value=[(key,'zone:0:0') for key in pads]), \
             patch.object(a,'native_chain',side_effect=contour), \
             patch.object(a,'ground_candidates',side_effect=lambda c:[(c[0],c[1]+1000000)]):
            result=a.plan_thermal_spokes(scene,nodes,guard,pcb)
            self.assertEqual([p['endpoint'] for p in result],['C1.2','C2.2'])
            guard.stub_clear=lambda *args:False
            with self.assertRaisesRegex(a.NativeError,'no legal supplemental thermal'):
                a.plan_thermal_spokes(scene,nodes,guard,pcb)

    def test_footprint_table_exact_qualified_libraries_and_no_fallback(self):
        text=a.footprint_table(self.data)
        self.assertEqual(text,a.footprint_table(copy.deepcopy(self.data)))
        self.assertEqual(text.count('(lib (name '),4)
        for cid,(library,name) in a.FOOTPRINTS.items():
            self.assertIn('(name '+json.dumps(library.removesuffix('.pretty'))+')',text)
            self.assertIn('(uri '+json.dumps(self.data['catalog'][cid]['footprint']['libraryPath'])+')',text)
        self.assertNotIn('https:',text)
        self.assertNotIn('$'+'{',text)
        self.assertEqual(a.checked_footprint_table(self.data,self.root),a.digest(self.root/'fp-lib-table'))
        (self.root/'fp-lib-table').write_text(text.replace('(type KiCad)','(type Legacy)',1))
        with self.assertRaisesRegex(a.NativeError,'differs from exact'):
            a.checked_footprint_table(self.data,self.root)
        source=pathlib.Path(sys.argv[1]).read_text()
        self.assertLess(source.index('fp.SetFPIDAsString(fpid)'),source.index('initial = identity(board)'))
        self.assertIn('qualified footprint library identity did not persist',source)

    def test_project_policy_strengthens_exact_ignored_checks_without_waivers(self):
        project=copy.deepcopy(self.project)
        settings=project['board']['design_settings']
        settings['rule_severities'].update(dict.fromkeys(a.ENABLED_DEFAULT_CHECKS,'ignore'))
        settings['rule_severities']['starved_thermal']='error'
        settings['rules'].update(min_clearance=.15,min_hole_clearance=.25,min_copper_edge_clearance=.5)
        with self.assertRaisesRegex(a.NativeError,'ignored'):
            a.project_policy(copy.deepcopy(project))
        result=a.project_policy(project,True)
        self.assertTrue(all(value=='error' for value in settings['rule_severities'].values()))
        self.assertEqual(result['board']['design_settings']['rules']['min_resolved_spokes'],2)
        for mutate,pattern in [
            (lambda s:s['rule_severities'].update(clearance='ignore'),'ignored'),
            (lambda s:s['rules'].update(min_resolved_spokes=1),'remain two'),
            (lambda s:s.update(drc_exclusions=['waiver']),'exclusions'),
            (lambda s:s['rule_severities'].pop('missing_courtyard'),'severities missing')]:
            changed=copy.deepcopy(result);mutate(changed['board']['design_settings'])
            with self.assertRaisesRegex(a.NativeError,pattern):a.project_policy(changed,True)

    def test_saved_project_hash_detects_later_native_rewrite(self):
        board=self.root/'final-board.kicad_pcb'
        board.write_text('native board')
        before_board=a.digest(board)
        project=self.root/'final-board.kicad_pro'
        data=copy.deepcopy(self.project)
        data['board']['design_settings']['rule_severities'].update(dict.fromkeys(a.ENABLED_DEFAULT_CHECKS,'ignore'))
        project.write_text(json.dumps(data))
        expected=a.project_hash(board,True)
        self.assertEqual(a.project_hash(board),expected)
        self.assertEqual(a.digest(board),before_board)
        project.write_text(json.dumps(data)) # Simulated stale native object save.
        with self.assertRaisesRegex(a.NativeError,'ignored'):
            a.project_hash(board)
        project.write_text(json.dumps(self.project,indent=4))
        self.assertNotEqual(a.project_hash(board),expected)

    def test_corridor_candidates_derive_integer_cells_uniform_rays_miss(self):
        center=(13675000,10025000)
        # Actual 26eYM2 obstacle intervals: 0.2mm signal traces expanded
        # by via radius0.3 + clearance0.15; native LGA pad plus via radius.
        boxes=[(12677400,9655000,13677400,11762500),
               (13784900,9655000,14884900,11762500),
               (11369900,10762500,14884900,11862500),
               (13200000,9475000,14150000,10575000)]
        candidates=a.corridor_candidates(center,boxes)
        self.assertLessEqual(len(candidates),256)
        self.assertEqual(candidates,a.corridor_candidates(center,list(reversed(boxes))))
        legal=lambda p:13677400<p[0]<13784900 and 10575000<p[1]<10762500
        self.assertFalse(any(legal(p) for p in a.ground_candidates(center)))
        self.assertTrue(any(legal(p) for p in candidates))
        self.assertIn((13731150,10668750),candidates)
        self.assertEqual(13677400-center[0],2400) # No tolerance/float relaxation.
        blocked=boxes+[(13677400,10575000,13784900,10762500)]
        self.assertFalse(any(legal(p) and not any(l<=p[0]<=r and t<=p[1]<=b for l,t,r,b in blocked)
                             for p in a.corridor_candidates(center,blocked)))

    def test_corridor_candidates_cannot_bypass_exact_native_guard(self):
        guard=object.__new__(a.GroundClearance)
        guard.pcbnew=types.SimpleNamespace(SHAPE_POLY_SET=type('Poly',(),{}),
            SHAPE=types.SimpleNamespace(Collide=lambda left,right,gap:left.Collide(right,gap)))
        guard.clearance=150000;guard.hole_clearance=250000;guard.edge_clearance=500000
        guard.width=24000000;guard.height=18000000;guard.layers=(0,2)
        guard.holes=[];guard.pads=[];guard.added_holes=[]
        class Shape:
            def BBox(self):return types.SimpleNamespace(GetLeft=lambda:13000000,GetRight=lambda:14000000,
                GetTop=lambda:10000000,GetBottom=lambda:11000000)
            def Collide(self,other,gap):return True
        guard.other={0:[Shape()],2:[]}
        shape=Shape()
        point=a.corridor_candidates((13675000,10025000),guard.corridor_boxes())[0]
        self.assertIsInstance(point[0],int)
        self.assertEqual(guard.reject(shape,0,shape,shape),'via-other-copper')
        self.assertEqual(guard.corridor_boxes(),[(12550000,9550000,14450000,11450000)])

    def test_collision_dispatch_matches_kicad_circle_hidden_base_overload(self):
        calls=[]
        class Base:
            def __init__(self,name):self.name=name
            def Collide(self,other,gap=0):
                calls.append(('base',self.name,other.name,gap));return True
        class Circle(Base):
            # Mirrors pcbnew.py6410: subclass only accepts SEG, not SHAPE.
            def Collide(self,segment,gap=0):
                raise TypeError('SHAPE_CIRCLE.Collide expects SEG')
        class Poly(Base):
            def Collide(self,other,gap=0):
                calls.append(('polygon-with-holes',self.name,other.name,gap));return False
        pcb=types.SimpleNamespace(SHAPE=Base,SHAPE_POLY_SET=Poly,F_Cu=0,B_Cu=2)
        previous=Circle('previous-drill');drill=Circle('new-drill');stub=Base('stub');poly=Poly('fill-with-hole')
        with self.assertRaises(TypeError):previous.Collide(drill,250000)
        self.assertTrue(a.shapes_collide(pcb,previous,drill,250000))
        self.assertTrue(a.shapes_collide(pcb,previous,stub,150000))
        self.assertFalse(a.shapes_collide(pcb,previous,poly,0))
        self.assertEqual(calls,[('base','previous-drill','new-drill',250000),
            ('base','previous-drill','stub',150000),('polygon-with-holes','fill-with-hole','previous-drill',0)])
        guard=object.__new__(a.GroundClearance)
        guard.pcbnew=pcb;guard.layers=(0,2);guard.other={0:[],2:[]};guard.pads=[];guard.holes=[]
        guard.added_holes=[previous];guard.hole_clearance=250000;guard.inside_edges=lambda shape:True
        self.assertEqual(guard.reject(stub,0,Circle('land'),drill),'hole-spacing')
        self.assertEqual(a.ground_links({'stitch-via:0':{0:previous},'stitch-via:1':{0:drill}},pcb),
            [('stitch-via:0','stitch-via:1')])
        self.assertEqual(a.ground_links({'stitch-via:0':{0:previous},'zone:0:0':{0:poly}},pcb),[])

    def test_manual_spokes_require_front_anchor_direct_pad_and_distinct_crossing(self):
        v=lambda x,y:types.SimpleNamespace(x=x,y=y)
        class Shape:
            def __init__(self,p=None,r=0):self.p=p;self.r=r
            def Collide(self,other,gap=0):
                return a.math.hypot(self.p.x-other.p.x,self.p.y-other.p.y)<=self.r+other.r+gap
        class Circle(Shape):
            def Collide(self,*args):raise TypeError('SEG-only subclass')
        class Boundary:
            def COutline(self,index):return [(0,0),(1000,0),(1000,1000),(0,1000)]
            def Contains(self,p):return 0<p.x<1000 and 0<p.y<1000
        class Poly:
            def Contains(self,p):return p.y>=2000
            def Collide(self,shape,gap=0):return False
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,SHAPE=Shape,SHAPE_POLY_SET=Poly,SHAPE_CIRCLE=Circle,VECTOR2I=v)
        pad=types.SimpleNamespace(GetEffectiveShape=lambda layer:types.SimpleNamespace(Collide=lambda p,g:250<p.x<750 and 250<p.y<750))
        good={'id':'good','net':'GND','layer':0,'start':v(500,500),'at':v(500,2500),'width':100}
        duplicate=dict(good,id='duplicate')
        wrong_net=dict(good,id='wrong-net',net='SDA')
        back=dict(good,id='back-only',layer=2)
        wrong_island=dict(good,id='wrong-island',at=v(2500,500))
        gap_start=dict(good,id='not-pad',start=v(900,500))
        tracks=[good,duplicate,wrong_net,back,wrong_island,gap_start]
        with patch.object(a,'native_chain',side_effect=lambda c:c):
            count,decisions=a.manual_spoke_credit('U1.1',pad,Boundary(),tracks,[Poly()],pcb)
        self.assertEqual(count,1)
        self.assertEqual([d['reason'] for d in decisions],[None,'duplicate-or-overlapping-manual-spoke',
            'wrong-net-or-layer','wrong-net-or-layer','endpoint-not-in-anchored-front-fill','not-directly-connected-to-pad'])
        poly=Poly();poly.Collide=lambda shape,gap:True
        with patch.object(a,'native_chain',side_effect=lambda c:c):
            count,decisions=a.manual_spoke_credit('U1.1',pad,Boundary(),[good],[poly],pcb)
        self.assertEqual(count,0)
        self.assertEqual(decisions[0]['reason'],'overlaps-existing-geometric-spoke')
        with patch.object(a,'native_chain',side_effect=lambda c:c):
            self.assertEqual(a.manual_spoke_credit('U1.1',pad,Boundary(),[good],[],pcb)[0],0)

    def test_qualified_manual_spoke_avoids_redundant_supplement_not_minimum(self):
        pad=object();nodes={'J1.2':{},'U1.1':{},'zone:0:0':{0:object()}}
        scene={'nodes':nodes,'pads':{'U1.1':pad}}
        pcb=types.SimpleNamespace(F_Cu=0)
        diagnostics=[]
        with patch.object(a,'thermal_measurements',return_value={'U1.1':{'geometricSpokes':1,'boundary':object()}}), \
             patch.object(a,'ground_links',return_value=[('J1.2','U1.1'),('U1.1','zone:0:0')]), \
             patch.object(a,'manual_spoke_credit',return_value=(1,[{'credited':True}])), \
             patch.object(a,'ground_candidates',side_effect=AssertionError('redundant supplemental search')):
            result=a.plan_thermal_spokes(scene,nodes,object(),pcb,[{'id':'stitch'}],diagnostics)
        self.assertEqual(result,[])
        self.assertEqual(diagnostics[0]['requiredSpokes'],2)
        self.assertFalse(diagnostics[0]['supplementalRequired'])
        self.assertEqual(diagnostics[0]['manualSpokes'],1)

    def test_thermal_failure_writes_bounded_plan_diagnostic_before_mutation(self):
        writes=[]
        scene={'nodes':{'J1.2':{}},'pads':{'J1.2':object()},'components':[{'J1.2'}]}
        board=types.SimpleNamespace(GetTracks=lambda:[],Add=lambda item:self.fail('no mutation on thermal failure'))
        pcb=types.SimpleNamespace(F_Cu=0)
        def fail(*args):
            args[-1].append({'pad':'U1.1','geometricSpokes':1,'manualSpokes':0,'requiredSpokes':2})
            raise a.NativeError('no legal supplemental thermal spoke for U1.1')
        with patch.object(a,'ground_scene',return_value=scene),patch.object(a,'GroundClearance',return_value=object()), \
             patch.object(a,'plan_thermal_spokes',side_effect=fail):
            with self.assertRaisesRegex(a.NativeError,'no legal supplemental'):
                a.stitch_ground(board,pcb,writes.append)
        self.assertEqual(len(writes),1)
        self.assertEqual(writes[0]['status'],'rejected')
        self.assertFalse(writes[0]['boardMutated'])
        self.assertEqual(writes[0]['thermals'][0]['requiredSpokes'],2)

    def test_diagnostic_bound_measures_exact_pretty_payload_and_exclusive_write(self):
        value={'items':[{'a':0,'b':0} for _ in range(8000)]}
        self.assertLess(len(json.dumps(value).encode()),262144)
        self.assertGreater(len((json.dumps(value,indent=2,sort_keys=True)+'\n').encode()),262144)
        with self.assertRaisesRegex(a.NativeError,'diagnostic exceeds'):
            a.write_plan_diagnostic(self.root,value)
        path=self.root/'ground-plan-diagnostic.json'
        self.assertFalse(path.exists())
        small={'version':1,'reason':'owned geometry','items':[1,2]}
        expected=(json.dumps(small,indent=2,sort_keys=True)+'\n').encode()
        a.write_plan_diagnostic(self.root,small)
        self.assertEqual(path.read_bytes(),expected)
        with self.assertRaises(FileExistsError):a.write_plan_diagnostic(self.root,small)

    def test_oblique_crossing_envelope_is_conservative_and_rejects_grazing_vertices(self):
        square=[(0,0),(10000,0),(10000,10000),(0,10000)]
        normal=a.crossing_envelope((5000,5000),(5000,15000),square,1000)
        oblique=a.crossing_envelope((2000,4000),(8000,16000),square,1000)
        self.assertEqual(normal,((5000,10000),503))
        self.assertEqual(oblique[0],(5000,10000))
        self.assertGreater(oblique[1],normal[1])
        self.assertGreaterEqual(oblique[1],a.math.ceil(501*a.math.sqrt(1.25))+2)
        # Obstacle at550nm would miss old501nm disk but not oblique envelope.
        self.assertLess(normal[1],550)
        self.assertGreaterEqual(oblique[1],550)
        self.assertIsNone(a.crossing_envelope((1000,9500),(11000,10500),square,1000))
        self.assertIsNone(a.crossing_envelope((9500,5000),(9500,15000),square,1000))
        self.assertIsNone(a.crossing_envelope((5000,5000),(15000,15000),square,1000))

    def test_opposite_native_pad_escapes_are_distinct_and_bounded(self):
        center=(13025000,7975000)
        pairs=a.opposite_escape_pairs(center,(500000,350000),90)
        self.assertEqual(len(pairs),8)
        self.assertEqual(pairs[0],((13025000,7375000),(13025000,8575000)))
        for left,right in pairs:
            self.assertEqual((left[0]+right[0],left[1]+right[1]),(2*center[0],2*center[1]))
        contour=[(-275000,-350000),(275000,-350000),(275000,350000),(-275000,350000)]
        north=a.crossing_envelope((0,0),(0,-600000),contour,200000)
        south=a.crossing_envelope((0,0),(0,600000),contour,200000)
        self.assertGreater(abs(north[0][1]-south[0][1]),north[1]+south[1])
        with self.assertRaisesRegex(a.NativeError,'non-square'):
            a.opposite_escape_pairs(center,(350000,350000),90)

    def test_blocked_opposite_pair_never_mutates_board(self):
        v=lambda x,y:types.SimpleNamespace(x=x,y=y)
        pads=[types.SimpleNamespace(GetNumber=lambda n=n:n,GetNetname=lambda:'GND',IsOnLayer=lambda l:True,
            GetPosition=lambda:v(13025000,7975000),GetDrillSize=lambda:v(0,0),GetSize=lambda:v(500000,350000),
            GetOrientationDegrees=lambda:90,TransformShapeToPolygon=lambda *args:None,
            GetEffectiveShape=lambda layer:types.SimpleNamespace(BBox=lambda:types.SimpleNamespace(GetLeft=lambda:0,GetTop=lambda:0,GetRight=lambda:1,GetBottom=lambda:1))) for n in ('1','5','7')]
        cap_pad=copy.copy(pads[0]);cap_pad.GetNumber=lambda:'2'
        board=types.SimpleNamespace(GetFootprints=lambda:[types.SimpleNamespace(GetReference=lambda:'U1',Pads=lambda:pads)]+
            [types.SimpleNamespace(GetReference=lambda ref=ref:ref,Pads=lambda:[cap_pad]) for ref in ('C1','C2')],
            Add=lambda item:self.fail('no partial reservation'))
        pcb=types.SimpleNamespace(F_Cu=0,VECTOR2I=v,SHAPE_CIRCLE=lambda *args:object(),SHAPE_SEGMENT=lambda *args:object(),
            FromMM=lambda n:n,ARC_LOW_DEF_MM=.005,ERROR_OUTSIDE=1,
            SHAPE_POLY_SET=lambda:types.SimpleNamespace(OutlineCount=lambda:1,HoleCount=lambda i:0,COutline=lambda i:object()))
        guard=types.SimpleNamespace(reject=lambda *args:'other-copper',added_holes=[],stub_obstacle_boxes=lambda layer:[],corridor_boxes=lambda:[])
        with patch.object(a,'GroundClearance',return_value=guard),patch.object(a,'native_chain',return_value=[]), \
             patch.object(a,'crossing_envelope',return_value=((0,0),100001)),self.assertRaisesRegex(a.NativeError,'opposite pre-route'):
            a.reserve_sensor_ground(board,pcb)

    def test_reserved_dsn_requires_fixed_exact_wires_vias_and_no_duplicates(self):
        reserved=[{'net':'GND','layer':0,'kind':'track','startNm':[13025000,7975000],'endNm':[13025000,7375000],'widthNm':200000},
                  {'net':'GND','layers':[0,2],'kind':'via','positionNm':[13025000,7375000],'widthNm':600000,'drillNm':300000}]
        wire='(wire (path F.Cu 200 13025 -7975 13025 -7375)(net GND)(type fix))'
        via='(via Via[0-1]_600:300_um 13025 -7375 (net GND)(type fix))'
        library='(library (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 600))(shape (circle B.Cu 600))(attach off)))'
        text='(pcb test (resolution um 10)'+library+'(wiring '+wire+via+'))'
        a.verify_reserved_dsn(text,reserved)
        # Authentic retained KiCad10.0.1 parser header, including its barequote.
        header='''(pcb "/Volumes/T9 Backup/owned/board.dsn"
  (parser
    (string_quote ")
    (space_in_quoted_tokens on)
    (host_cad "KiCad's Pcbnew")
    (host_version "10.0.1")
  )
  (resolution um 10)
  (unit um)
'''
        a.verify_reserved_dsn(header+library+'(wiring '+wire+via+'))',reserved)
        for malformed in [header.replace('(string_quote ")','(string_quote "unterminated)'),
                          header.replace('(host_version "10.0.1")','(host_version "unterminated)'),
                          header.replace('(parser','(not_parser')]:
            with self.assertRaises((a.NativeError,json.JSONDecodeError)):
                a.verify_reserved_dsn(malformed+'(wiring '+wire+via+'))',reserved)
        for bad in [text.replace('type fix','type route',1),text.replace('-7375','-7374',1),
                    text.replace('600:300','600:250'),text.replace(wire,wire+wire),text.replace(via,'')]:
            with self.assertRaises(a.NativeError):a.verify_reserved_dsn(bad,reserved)

    def test_reserved_dsn_sda_exact_net_geometry_layers_and_dynamic_counts(self):
        ground=[{'net':'GND','layer':0,'kind':'track','startNm':[13025000,7975000],
                 'endNm':[13025000,7375000],'widthNm':200000}]
        sda=[{'net':'SDA','layer':0,'kind':'track','startNm':[14325000,7975000],
              'endNm':[14325000,7175000],'widthNm':200000},
             {'net':'SDA','layers':[0,2],'kind':'via','positionNm':[14325000,7175000],
              'widthNm':600000,'drillNm':300000}]
        library='(library (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 600))(shape (circle B.Cu 600))(attach off)))'
        gw='(wire (path F.Cu 200 13025 -7975 13025 -7375)(net GND)(type fix))'
        sw='(wire (path F.Cu 200 14325 -7975 14325 -7175)(net SDA)(type fix))'
        sv='(via "Via[0-1]_600:300_um" 14325 -7175 (net SDA)(type fix))'
        text='(pcb test (resolution um 10)'+library+'(wiring '+gw+sw+sv+'))'
        a.verify_reserved_dsn(text,ground+sda)
        # Every expected count is taken from retained records, not GND-only constants.
        a.verify_reserved_dsn(text.replace(gw,''),sda)
        for bad in [text.replace(sw,''),text.replace(sv,''),text.replace(sw,sw+sw),text.replace(sv,sv+sv),
                    text.replace('net SDA','net GND'),text.replace('net SDA','net SCL'),
                    text.replace('14325 -7175','14325 -7174',1),text.replace('path F.Cu 200 14325','path F.Cu 100 14325'),
                    text.replace('path F.Cu 200 14325','path B.Cu 200 14325'),text.replace('net SDA)(type fix','net SDA)(type route'),
                    text.replace('circle B.Cu 600','circle F.Cu 600'),text.replace('circle B.Cu 600','circle B.Cu 500'),
                    text.replace('600:300','600:200'),text.replace('(shape (circle B.Cu 600))','')]:
            with self.subTest(bad=bad),self.assertRaises(a.NativeError):a.verify_reserved_dsn(bad,ground+sda)
        for field,value in [('net','GND'),('layer',2),('widthNm',100000)]:
            bad=copy.deepcopy(ground+sda);bad[1][field]=value
            with self.assertRaises(a.NativeError):a.verify_reserved_dsn(text,bad)
        bad=copy.deepcopy(ground+sda);bad[2]['layers']=[0]
        with self.assertRaises(a.NativeError):a.verify_reserved_dsn(text,bad)

    def sda_scene(self):
        # Pure capsule geometry, including complete track width, via lands and
        # drills. Original 12 tracks/10 vias copied from the reviewed owned DSN;
        # no fixture reads private run data or invokes pcbnew.
        v=lambda x,y:types.SimpleNamespace(x=x,y=y)
        class Shape:
            def __init__(self,start,end,radius):self.start=start;self.end=end;self.radius=radius
            def BBox(self):
                return types.SimpleNamespace(GetLeft=lambda:min(self.start.x,self.end.x)-self.radius,
                    GetRight=lambda:max(self.start.x,self.end.x)+self.radius,
                    GetTop=lambda:min(self.start.y,self.end.y)-self.radius,
                    GetBottom=lambda:max(self.start.y,self.end.y)+self.radius)
            def Collide(self,other,gap=0):
                def distance(p,u,w):
                    dx,dy=w.x-u.x,w.y-u.y
                    t=max(0,min(1,((p.x-u.x)*dx+(p.y-u.y)*dy)/(dx*dx+dy*dy))) if dx or dy else 0
                    return a.math.hypot(p.x-u.x-t*dx,p.y-u.y-t*dy)
                def cross(p,q,r):return (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)
                p,q,r,s=self.start,self.end,other.start,other.end
                crossing=cross(p,q,r)*cross(p,q,s)<0 and cross(r,s,p)*cross(r,s,q)<0
                separation=0 if crossing else min(distance(p,r,s),distance(q,r,s),distance(r,p,q),distance(s,p,q))
                return separation < self.radius+other.radius+gap
        tracks=[]
        class Track:
            def __init__(self,board):
                self.uid='new-'+str(len(tracks));self.m_Uuid=types.SimpleNamespace(AsString=lambda:self.uid)
                self.locked=False;self.net='GND';self.width=200000;self.layer=0
            def SetStart(self,p):self.start=p
            def SetEnd(self,p):self.end=p
            def SetWidth(self,n):self.width=n
            def SetLayer(self,n):self.layer=n
            def SetNet(self,n):self.net=n.name
            def SetLocked(self,b):self.locked=b
            def GetNetname(self):return self.net
            def IsLocked(self):return self.locked
            def GetStart(self):return self.start
            def GetEnd(self):return self.end
            def GetWidth(self):return self.width
            def GetLayer(self):return self.layer
            def IsOnLayer(self,n):return n==self.layer
            def GetEffectiveShape(self):return Shape(self.start,self.end,self.width/2)
        class Via(Track):
            def SetViaType(self,n):self.via_type=n
            def GetViaType(self):return self.via_type
            def SetLayerPair(self,l,r):self.layers=(l,r)
            def SetPosition(self,p):self.position=p
            def SetDrill(self,n):self.drill=n
            def GetPosition(self):return self.position
            def GetDrillValue(self):return self.drill
            def IsOnLayer(self,n):return n in self.layers
            def GetEffectiveShape(self,layer):return Shape(self.position,self.position,self.width/2)
            def GetEffectiveHoleShape(self):return Shape(self.position,self.position,self.drill/2)
        def add(item):
            item.uid='item-'+str(len(tracks));tracks.append(item)
        board=types.SimpleNamespace(GetTracks=lambda:tracks,Add=add,Zones=lambda:[],
            FindNet=lambda name:types.SimpleNamespace(name=name,GetNetCode=lambda:3))
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,PCB_TRACK=Track,PCB_VIA=Via,VIATYPE_THROUGH=3,VECTOR2I=v,
            SHAPE=Shape,SHAPE_POLY_SET=type('Poly',(),{}),SHAPE_SEGMENT=lambda p,q,w:Shape(p,q,w/2),
            SHAPE_CIRCLE=lambda p,r:Shape(p,p,r))
        mm=lambda pair:v(*(round(n*1e6) for n in pair))
        for start,end in [((12.7,12.08),(11.9,12.08)),((13.025,7.975),(13.025,8.575)),
                          ((14.975,10.5825),(15.38,10.5825)),((14.7,12.08),(15.5,12.08)),
                          ((14.975,10.025),(14.975,9.425)),((14.975,10.025),(14.975,10.5825)),
                          ((12.7,12.08),(13.5,12.08)),((14.7,12.08),(14.07,12.08)),
                          ((13.025,7.975),(13.025,7.375)),((13.675,10.025),(13.675,10.625)),
                          ((14.07,12.08),(14.07,12.645)),((13.675,10.025),(13.675,9.425))]:
            item=Track(board);item.SetStart(mm(start));item.SetEnd(mm(end));item.SetLocked(True);add(item)
        for at in [(15.38,10.5825),(15.5,12.08),(13.5,12.08),(13.675,10.625),(13.025,8.575),
                   (14.07,12.645),(14.975,9.425),(11.9,12.08),(13.025,7.375),(13.675,9.425)]:
            item=Via(board);item.SetPosition(mm(at));item.SetLayerPair(0,2);item.SetWidth(600000)
            item.SetDrill(300000);item.SetViaType(3);item.SetLocked(True);add(item)
        pads={}
        for endpoint,net,at in [('U1.3','SDA',(14.325,7.975)),('J1.3','SDA',(3,10.27)),
                                ('R1.2','SDA',(17.48,6.3)),('U1.2','3V3',(13.675,7.975))]:
            p=types.SimpleNamespace(net=net,position=mm(at),m_Uuid=types.SimpleNamespace(AsString=lambda e=endpoint:e))
            p.GetNumber=lambda e=endpoint:e.split('.')[1];p.GetNetname=lambda p=p:p.net
            p.IsOnLayer=lambda layer:layer==0;p.GetPosition=lambda p=p:p.position;p.GetDrillSize=lambda:v(0,0)
            p.GetEffectiveShape=lambda layer,p=p:Shape(p.position,p.position,250000)
            pads[endpoint]=p
        fps=[types.SimpleNamespace(GetReference=lambda ref=ref:ref,
             Pads=lambda ref=ref:[pad for endpoint,pad in pads.items() if endpoint.startswith(ref+'.')]) for ref in ('U1','J1','R1')]
        board.GetFootprints=lambda:fps
        return board,pcb,tracks,pads

    def test_sda_seed_exact_clearance_and_22_ground_records_unchanged(self):
        board,pcb,tracks,pads=self.sda_scene()
        before=a.reserved_copper(board,pcb)
        with patch.object(a,'checked_ground_edges'):
            guard=a.GroundClearance(board,pcb,'SDA')
            self.assertEqual(len(guard.other[0]),23) # All 22 GND plus 3V3 pad.
            self.assertEqual(len(guard.other[2]),10)
            self.assertEqual(len(guard.holes),10);self.assertTrue(all(not own for _,own in guard.holes))
            reserved=a.reserve_sensor_sda(board,self.data,pcb)
            a.check_reserved_clearance(board,pcb)
        self.assertEqual(len(reserved),24)
        self.assertEqual([item for item in reserved if item['net']=='GND'],before)
        sda=[item for item in reserved if item['net']=='SDA']
        track=next(item for item in sda if item['kind']=='track');via=next(item for item in sda if item['kind']=='via')
        self.assertEqual((track['startNm'],track['endNm'],track['widthNm'],track['layer']),
                         ([14325000,7975000],[14325000,7175000],200000,0))
        self.assertEqual((via['positionNm'],via['widthNm'],via['drillNm'],via['layers']),([14325000,7175000],600000,300000,[0,2]))
        self.assertTrue(all(item['locked'] for item in sda));self.assertEqual(tracks[-1].via_type,pcb.VIATYPE_THROUGH)
        for index in (-1,-2):
            lost=tracks.pop(index)
            with self.assertRaisesRegex(a.NativeError,'dropped, duplicated or changed'):a.assert_reserved(reserved,board,pcb)
            tracks.insert(index if index>=0 else len(tracks)+index+1,lost)
        a.assert_reserved(reserved,board,pcb)
        for item in tracks[-2:]:
            duplicate=copy.copy(item);duplicate.locked=False;duplicate.uid='duplicate';tracks.append(duplicate)
            with self.assertRaisesRegex(a.NativeError,'duplicate SDA copper'):a.assert_reserved(reserved,board,pcb)
            tracks.pop()
        tracks[-1].net='GND'
        with self.assertRaises(a.NativeError):a.assert_reserved(reserved,board,pcb)

    def test_sda_seed_rejects_wrong_proposal_pad_and_unsafe_full_geometry_before_add(self):
        for mutation in ('proposal','wrong-net','missing-pad','moved-pad','stub','via-back','hole','via-in-pad','small-radius'):
            with self.subTest(mutation=mutation):
                board,pcb,tracks,pads=self.sda_scene();data=copy.deepcopy(self.data)
                if mutation=='proposal':data['nets'][2]['pins'][0]['pad']='4'
                if mutation=='wrong-net':pads['U1.3'].net='3V3'
                if mutation=='missing-pad':del pads['U1.3']
                if mutation=='moved-pad':pads['U1.3'].position.x+=1
                if mutation in ('stub','via-back'):
                    obstacle=tracks[0];obstacle.SetLayer(2 if mutation=='via-back' else 0)
                    y=7175000 if mutation=='via-back' else 7575000
                    obstacle.SetStart(pcb.VECTOR2I(14325000,y));obstacle.SetEnd(pcb.VECTOR2I(14400000,y))
                if mutation=='hole':tracks[12].position=pcb.VECTOR2I(14990000,7175000);tracks[12].drill=900000
                if mutation=='via-in-pad':pads['R1.2'].position=pcb.VECTOR2I(14325000,7175000)
                before=a.reserved_copper(board,pcb);count=len(tracks)
                with patch.object(a,'checked_ground_edges'),patch.object(a,'SDA_ESCAPE_NM',400000 if mutation=='small-radius' else 800000):
                    with self.assertRaises(a.NativeError):a.reserve_sensor_sda(board,data,pcb)
                self.assertEqual(len(tracks),count);self.assertEqual(a.reserved_copper(board,pcb),before)
        with self.assertRaisesRegex(a.NativeError,'unreviewed clearance'):
            a.GroundClearance(object(),object(),'3V3')

    def test_sda_final_clearance_rejects_new_foreign_copper_and_holes(self):
        for layer,net,is_via in [(0,'3V3',False),(2,'GND',False),(0,'SCL',True)]:
            board,pcb,tracks,pads=self.sda_scene()
            with patch.object(a,'checked_ground_edges'):
                reserved=a.reserve_sensor_sda(board,self.data,pcb)
                if is_via:
                    item=pcb.PCB_VIA(board);item.SetLayerPair(0,2);item.SetPosition(pcb.VECTOR2I(14990000,7175000))
                    item.SetWidth(600000);item.SetDrill(900000)
                else:
                    item=pcb.PCB_TRACK(board);item.SetLayer(layer);item.SetStart(pcb.VECTOR2I(14325000,7175000))
                    item.SetEnd(pcb.VECTOR2I(14400000,7175000))
                item.net=net;board.Add(item)
                a.assert_reserved(reserved,board,pcb) # UUID/geometry retention is not sufficient.
                with self.assertRaises(a.NativeError):a.check_reserved_clearance(board,pcb)

    def test_sda_final_clearance_includes_foreign_filled_zone_polygons(self):
        board,pcb,tracks,pads=self.sda_scene()
        with patch.object(a,'checked_ground_edges'):
            a.reserve_sensor_sda(board,self.data,pcb)
            land=tracks[-1].GetEffectiveShape(0)
            zone=types.SimpleNamespace(GetNetname=lambda:'GND',GetLayer=lambda:2,IsFilled=lambda:True,
                HasFilledPolysForLayer=lambda layer:True,
                GetFilledPolysList=lambda layer:types.SimpleNamespace(OutlineCount=lambda:1,UnitSet=lambda index:land))
            board.Zones=lambda:[zone]
            with self.assertRaisesRegex(a.NativeError,'reserved via clearance'):a.check_reserved_clearance(board,pcb)
            zone.IsFilled=lambda:False
            with self.assertRaisesRegex(a.NativeError,'foreign zone native fill'):a.check_reserved_clearance(board,pcb)

    def scl_scene(self):
        # Separate fixture: leave the reviewed SDA north tests/candidate intact.
        # All pads below are transcribed from approved GwWxsz prepared-evidence;
        # roundrect core + radius and rotated rectangles, not bounding circles.
        board,pcb,tracks,_=self.sda_scene()
        with patch.object(a,'checked_ground_edges'):
            a.reserve_sensor_sda(board,self.data,pcb)
        v=pcb.VECTOR2I
        class Rect(pcb.SHAPE_POLY_SET):
            def __init__(self,p,w,h,r):self.p=p;self.w=w;self.h=h;self.r=r
            def BBox(self):
                return types.SimpleNamespace(GetLeft=lambda:self.p.x-self.w/2,GetRight=lambda:self.p.x+self.w/2,
                    GetTop=lambda:self.p.y-self.h/2,GetBottom=lambda:self.p.y+self.h/2)
            def Collide(self,other,gap=0):
                x,y=self.p.x,self.p.y;dx,dy=self.w/2-self.r,self.h/2-self.r
                corners=[v(x-dx,y-dy),v(x+dx,y-dy),v(x+dx,y+dy),v(x-dx,y+dy)]
                if any(x-dx<=p.x<=x+dx and y-dy<=p.y<=y+dy for p in (other.start,other.end)):return True
                return any(pcb.SHAPE(p,q,self.r).Collide(other,gap) for p,q in zip(corners,corners[1:]+corners[:1]))
        pads={}
        records=[]
        for i,(net,x,y) in enumerate([('GND',13.025,7.975),('3V3',13.675,7.975),('SDA',14.325,7.975),
                ('SCL',14.975,7.975),('GND',14.975,10.025),('3V3',14.325,10.025),
                ('GND',13.675,10.025),('3V3',13.025,10.025)],1):
            records.append(('U1.'+str(i),net,x,y,350000,500000,0,0))
        for ref,x in [('C1',12.7),('C2',14.7)]:
            for n,net,y in [(1,'3V3',11.12),(2,'GND',12.08)]:
                records.append((ref+'.'+str(n),net,x,y,620000,560000,140000,0))
        for ref,y,signal in [('R1',6.3,'SDA'),('R2',8,'SCL')]:
            for n,net,x in [(1,'3V3',16.49),(2,signal,17.51)]:
                records.append((ref+'.'+str(n),net,x,y,540000,640000,135000,0))
        for n,net in enumerate(('3V3','GND','SDA','SCL'),1):
            records.append(('J1.'+str(n),net,3,5.19+2.54*(n-1),1700000,1700000,0 if n==1 else 850000,1000000))
        for endpoint,net,x,y,w,h,r,drill in records:
            p=types.SimpleNamespace(net=net,position=v(round(x*1e6),round(y*1e6)),drill=drill,
                layers=(0,2) if drill else (0,),m_Uuid=types.SimpleNamespace(AsString=lambda e=endpoint:e))
            p.GetNumber=lambda e=endpoint:e.split('.')[1];p.GetNetname=lambda p=p:p.net
            p.IsOnLayer=lambda layer,p=p:layer in p.layers;p.GetPosition=lambda p=p:p.position
            p.GetDrillSize=lambda p=p:v(p.drill,p.drill)
            p.GetEffectiveShape=lambda layer,p=p,w=w,h=h,r=r:Rect(p.position,w,h,r)
            p.GetEffectiveHoleShape=lambda p=p:pcb.SHAPE_CIRCLE(p.position,p.drill/2)
            pads[endpoint]=p
        fps=[types.SimpleNamespace(GetReference=lambda ref=ref:ref,
             Pads=lambda ref=ref:[pad for endpoint,pad in pads.items() if endpoint.startswith(ref+'.')]) for ref in a.PARTS]
        board.GetFootprints=lambda:fps
        board.FindNet=lambda name:types.SimpleNamespace(name=name,GetNetname=lambda:name,GetNetCode=lambda:4)
        return board,pcb,tracks,pads

    def test_scl_seed_exact_east_clearance_preserves_all_24_prior_records(self):
        board,pcb,tracks,pads=self.scl_scene()
        before=copy.deepcopy(a.reserved_copper(board,pcb))
        pad_state=[(key,p.net,a.xy(p.position),p.drill,p.layers) for key,p in pads.items()]
        proposal=copy.deepcopy(self.data)
        with patch.object(a,'checked_ground_edges'):
            guard=a.GroundClearance(board,pcb,'SCL')
            self.assertEqual(len(guard.other[0]),41) # 24 GND/SDA reservations + 17 foreign pads.
            self.assertEqual(len(guard.other[2]),14) # 11 foreign vias + three foreign THT pads.
            self.assertEqual(len(guard.holes),15)
            self.assertEqual(sum(not own for _,own in guard.holes),14)
            with patch.object(a.GroundClearance,'reject',autospec=True,side_effect=a.GroundClearance.reject) as reject:
                reserved=a.reserve_sensor_scl(board,self.data,pcb)
                self.assertEqual(reject.call_count,1)
            a.check_reserved_clearance(board,pcb)
        self.assertEqual(len(reserved),26)
        self.assertEqual([item for item in reserved if item['net']!='SCL'],before)
        self.assertEqual(pad_state,[(key,p.net,a.xy(p.position),p.drill,p.layers) for key,p in pads.items()])
        self.assertEqual(proposal,self.data)
        scl=[item for item in reserved if item['net']=='SCL']
        track=next(item for item in scl if item['kind']=='track');via=next(item for item in scl if item['kind']=='via')
        self.assertEqual((track['startNm'],track['endNm'],track['widthNm'],track['layer']),
                         ([14975000,7975000],[15625000,7975000],200000,0))
        self.assertEqual((via['positionNm'],via['widthNm'],via['drillNm'],via['layers'],via['viaType']),
                         ([15625000,7975000],600000,300000,[0,2],pcb.VIATYPE_THROUGH))
        self.assertTrue(all(item['locked'] for item in scl))
        # Router's already-reviewed single-wire-via entry is fully capped inside
        # this annulus, not a second candidate and not a router change.
        offset=a.math.hypot(15625000-15542500,7975000-8092500)
        self.assertAlmostEqual(offset,143570.540154,places=5)
        self.assertGreater(300000-offset-100000,0)

    def test_scl_preflight_rejects_noncanonical_input_before_board_add(self):
        for mutation in ('proposal','duplicate-net','duplicate-pin','wrong-net','missing-pad','extra-scl-pad',
                         'moved-pad','back-pad','drilled-pad','missing-native-net','wrong-native-net',
                         'missing-ground','missing-sda','changed-sda','duplicate-ground','already-scl'):
            with self.subTest(mutation=mutation):
                board,pcb,tracks,pads=self.scl_scene();data=copy.deepcopy(self.data)
                if mutation=='proposal':data['nets'][3]['pins'][0]['pad']='3'
                if mutation=='duplicate-net':data['nets'].append(copy.deepcopy(data['nets'][3]))
                if mutation=='duplicate-pin':data['nets'][3]['pins'].append(copy.deepcopy(data['nets'][3]['pins'][0]))
                if mutation=='wrong-net':pads['U1.4'].net='SDA'
                if mutation=='missing-pad':del pads['U1.4']
                if mutation=='extra-scl-pad':pads['U1.2'].net='SCL'
                if mutation=='moved-pad':pads['U1.4'].position.x+=1
                if mutation=='back-pad':pads['U1.4'].layers=(0,2)
                if mutation=='drilled-pad':pads['U1.4'].drill=300000
                if mutation=='missing-native-net':board.FindNet=lambda name:None
                if mutation=='wrong-native-net':board.FindNet=lambda name:types.SimpleNamespace(GetNetCode=lambda:2,GetNetname=lambda:'GND')
                if mutation=='missing-ground':tracks.pop(0)
                if mutation=='missing-sda':tracks.pop()
                if mutation=='changed-sda':tracks[-2].end.y+=1
                if mutation=='duplicate-ground':
                    item=copy.copy(tracks[0]);item.locked=False;board.Add(item)
                if mutation=='already-scl':tracks[0].net='SCL'
                before=a.reserved_copper(board,pcb);count=len(tracks)
                with patch.object(a,'checked_ground_edges'),patch.object(board,'Add',wraps=board.Add) as add:
                    with self.assertRaises(a.NativeError):a.reserve_sensor_scl(board,data,pcb)
                    add.assert_not_called()
                self.assertEqual(len(tracks),count);self.assertEqual(a.reserved_copper(board,pcb),before)

    def test_scl_full_native_guard_rejects_foreign_copper_pad_and_drill_before_add(self):
        for mutation in ('gnd-stub','sda-stub','back-land','drill-copper','hole-spacing','hole-land',
                         'same-net-hole','via-in-pad','foreign-pad','missing-shape','missing-hole'):
            with self.subTest(mutation=mutation):
                board,pcb,tracks,pads=self.scl_scene()
                if mutation in ('gnd-stub','sda-stub','back-land','drill-copper','missing-shape'):
                    item=pcb.PCB_TRACK(board);item.net='SDA' if mutation=='sda-stub' else 'GND'
                    item.layer=2 if mutation in ('back-land','drill-copper') else 0
                    # Back copper inside the drill/copper clearance envelope.
                    x,y=(15935000,8175000) if mutation=='drill-copper' else (15300000,7975000) if mutation.endswith('stub') else (15625000,7975000)
                    item.SetStart(pcb.VECTOR2I(x,y));item.SetEnd(pcb.VECTOR2I(x+10000,y));item.width=20000 if mutation=='drill-copper' else 200000
                    if mutation=='missing-shape':item.GetEffectiveShape=lambda:None
                    board.Add(item)
                if mutation in ('hole-spacing','hole-land','same-net-hole','missing-hole'):
                    item=pcb.PCB_VIA(board);item.net='SCL' if mutation=='same-net-hole' else 'GND'
                    item.SetLayerPair(0,2);item.SetWidth(100000);item.SetDrill(600000)
                    # .15 copper gap, .25 drill/copper gap; only hole/hole fails
                    # at .68mm; .78mm separates holes but violates hole/land.
                    item.SetPosition(pcb.VECTOR2I(15625000,7975000+(780000 if mutation=='hole-land' else 680000)))
                    if mutation=='missing-hole':item.GetEffectiveHoleShape=lambda:None
                    board.Add(item)
                if mutation in ('via-in-pad','foreign-pad'):
                    pads['R2.2' if mutation=='via-in-pad' else 'R2.1'].position=pcb.VECTOR2I(15625000,7975000)
                before=a.reserved_copper(board,pcb);count=len(tracks)
                with patch.object(a,'checked_ground_edges'),patch.object(board,'Add',wraps=board.Add) as add:
                    with self.assertRaises(a.NativeError):a.reserve_sensor_scl(board,self.data,pcb)
                    add.assert_not_called()
                self.assertEqual(len(tracks),count);self.assertEqual(a.reserved_copper(board,pcb),before)

    def test_scl_reservation_retention_rejects_drop_duplicate_wrong_net_and_via_type(self):
        board,pcb,tracks,pads=self.scl_scene()
        with patch.object(a,'checked_ground_edges'):reserved=a.reserve_sensor_scl(board,self.data,pcb)
        for index in (24,25):
            item=tracks.pop(index)
            with self.assertRaises(a.NativeError):a.assert_reserved(reserved,board,pcb)
            tracks.insert(index,item)
            for field,value in [('net','GND'),('net','SDA'),('locked',False),('width',100000)]:
                original=getattr(item,field);setattr(item,field,value)
                with self.assertRaises(a.NativeError):a.assert_reserved(reserved,board,pcb)
                setattr(item,field,original)
            duplicate=copy.copy(item);duplicate.locked=False;board.Add(duplicate)
            with self.assertRaisesRegex(a.NativeError,'duplicate SCL copper'):a.assert_reserved(reserved,board,pcb)
            tracks.pop()
        tracks[-1].via_type=99
        with self.assertRaisesRegex(a.NativeError,'SCL via is not plated through'):a.assert_reserved(reserved,board,pcb)
        tracks[-1].via_type=pcb.VIATYPE_THROUGH;tracks[-1].layers=(0,)
        with self.assertRaises(a.NativeError):a.assert_reserved(reserved,board,pcb)

    def test_scl_final_clearance_includes_foreign_copper_holes_and_both_layer_zones(self):
        for mutation in ('front-track','back-track','hole','front-zone','back-zone','missing-zone-fill'):
            with self.subTest(mutation=mutation):
                board,pcb,tracks,pads=self.scl_scene()
                with patch.object(a,'checked_ground_edges'):
                    reserved=a.reserve_sensor_scl(board,self.data,pcb)
                    if mutation.endswith('track'):
                        item=pcb.PCB_TRACK(board);item.net='GND';item.layer=2 if mutation=='back-track' else 0
                        item.SetStart(pcb.VECTOR2I(15625000,7975000));item.SetEnd(pcb.VECTOR2I(15725000,7975000));board.Add(item)
                    elif mutation=='hole':
                        item=pcb.PCB_VIA(board);item.net='SDA';item.SetLayerPair(0,2)
                        item.SetPosition(pcb.VECTOR2I(15625000,8655000));item.SetWidth(100000);item.SetDrill(600000);board.Add(item)
                    else:
                        land=tracks[-1].GetEffectiveShape(0)
                        zone=types.SimpleNamespace(GetNetname=lambda:'GND',GetLayer=lambda:0 if mutation=='front-zone' else 2,
                            IsFilled=lambda:mutation!='missing-zone-fill',HasFilledPolysForLayer=lambda layer:True,
                            GetFilledPolysList=lambda layer:types.SimpleNamespace(OutlineCount=lambda:1,UnitSet=lambda index:land))
                        board.Zones=lambda:[zone]
                    a.assert_reserved(reserved,board,pcb)
                    with self.assertRaises(a.NativeError):a.check_reserved_clearance(board,pcb)

    def test_scl_dsn_exact_per_net_multiset_and_through_padstack(self):
        board,pcb,tracks,pads=self.scl_scene()
        with patch.object(a,'checked_ground_edges'):reserved=a.reserve_sensor_scl(board,self.data,pcb)
        records=[]
        for item in reserved:
            if item['kind']=='track':
                x,y=item['startNm'];u,v=item['endNm']
                records.append('(wire (path F.Cu 200 %s %s %s %s)(net %s)(type fix))'%(x/1000,-y/1000,u/1000,-v/1000,item['net']))
            else:
                x,y=item['positionNm']
                records.append('(via "Via[0-1]_600:300_um" %s %s (net %s)(type fix))'%(x/1000,-y/1000,item['net']))
        library='(library (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 600))(shape (circle B.Cu 600))(attach off)))'
        text='(pcb test (resolution um 10)'+library+'(wiring '+''.join(records)+'))'
        a.verify_reserved_dsn(text,reserved)
        scl=[record for record in records if '(net SCL)' in record]
        self.assertEqual(len(scl),2)
        for record in scl:
            for replacement in ('',record+record,record.replace('(net SCL)','(net SDA)'),record.replace('(net SCL)','(net GND)'),
                                record.replace('15625.0','15625.1'),record.replace('type fix','type route')):
                with self.assertRaises(a.NativeError):a.verify_reserved_dsn(text.replace(record,replacement),reserved)
        for bad in (text.replace('circle B.Cu 600','circle F.Cu 600'),text.replace('circle B.Cu 600','circle B.Cu 500'),
                    text.replace('600:300','600:200'),text.replace('(shape (circle F.Cu 600))',''),
                    text.replace('attach off','attach on')):
            with self.assertRaises(a.NativeError):a.verify_reserved_dsn(bad,reserved)
        wire=next(record for record in scl if record.startswith('(wire'))
        for replacement in (wire.replace('F.Cu','B.Cu'),wire.replace('F.Cu 200','F.Cu 100'),
                            wire.replace('15625.0 -7975.0','14975.0 -7325.0')):
            with self.assertRaises(a.NativeError):a.verify_reserved_dsn(text.replace(wire,replacement),reserved)

    def test_reserved_copper_checks_uuid_lock_geometry_and_unlocked_duplicates(self):
        v=lambda x,y:types.SimpleNamespace(x=x,y=y)
        class Track:
            def __init__(self,uuid,locked=True):
                self.m_Uuid=types.SimpleNamespace(AsString=lambda:uuid);self.locked=locked
            def IsLocked(self):return self.locked
            def GetNetname(self):return 'GND'
            def GetWidth(self):return 200000
            def GetStart(self):return v(13025000,7975000)
            def GetEnd(self):return v(13025000,7375000)
            def GetLayer(self):return 0
        items=[Track('exact')]
        board=types.SimpleNamespace(GetTracks=lambda:items)
        pcb=types.SimpleNamespace(PCB_VIA=type('Via',(),{}),F_Cu=0,B_Cu=2)
        expected=a.reserved_copper(board,pcb)
        a.assert_reserved(expected,board,pcb)
        items.append(Track('duplicate',False))
        with self.assertRaisesRegex(a.NativeError,'duplicate GND copper'):a.assert_reserved(expected,board,pcb)
        items.pop();items[0].locked=False
        with self.assertRaisesRegex(a.NativeError,'dropped, duplicated or changed'):a.assert_reserved(expected,board,pcb)
        items[0]=Track('changed-uuid')
        with self.assertRaises(a.NativeError):a.assert_reserved(expected,board,pcb)

    def test_u15_dogleg_preserves_whole_bend_gap_in_exact_15um_window(self):
        center=(14975000,10025000);size=(500000,350000)
        # Native C2.1 pad bbox expanded for .2mm track+.15 clearance.
        stub_boxes=[(14140000,10590000,15260000,11650000)]
        via_boxes=[(13940000,10390000,15460000,11850000)]
        choices=a.dogleg_escape_candidates(center,size,90,1,stub_boxes,via_boxes)
        self.assertTrue(choices)
        for corner,end in choices:
            self.assertEqual(corner,(14975000,10582500))
            self.assertEqual(end[1],corner[1])
            self.assertGreater(corner[1]-100000,10475000) # WHOLE bend beyond full thermal gap.
            self.assertGreaterEqual(10840000-(corner[1]+100000),150000)
        self.assertTrue(any(end[0]>15460000 for _,end in choices))
        self.assertLess(10532500-100000,10475000) # old centerline-only midpoint invalid.
        blocked=[(14140000,10575000,15260000,11650000)]
        self.assertEqual(a.dogleg_escape_candidates(center,size,90,1,blocked,via_boxes),[])
        too_tight=[(14140000,10575002,15260000,11650000)]
        self.assertEqual(a.dogleg_escape_candidates(center,size,90,1,too_tight,via_boxes),[])

    def test_reserved_stub_rejects_snapped_foreign_track_and_via(self):
        class Shape:
            def __init__(self,name):self.name=name
            def Collide(self,other,gap=0):return (self.name,other.name,gap) in hits
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,SHAPE=Shape,SHAPE_POLY_SET=type('Poly',(),{}),PCB_VIA=type('Via',(),{}))
        guard=object.__new__(a.GroundClearance);guard.pcbnew=pcb;guard.clearance=150000;guard.hole_clearance=250000
        guard.inside_edges=lambda shape:True
        guard.other={0:[Shape('snapped-track'),Shape('via-land')],2:[]}
        guard.holes=[(Shape('via-hole'),False)]
        stub=types.SimpleNamespace(IsLocked=lambda:True,GetNetname=lambda:'GND',GetEffectiveShape=lambda:Shape('reserved-stub'),GetLayer=lambda:0)
        board=types.SimpleNamespace(GetTracks=lambda:[stub],GetFootprints=lambda:[])
        hits=set()
        with patch.object(a,'GroundClearance',return_value=guard):
            a.check_reserved_clearance(board,pcb)
            for hit in [('snapped-track','reserved-stub',150000),('via-land','reserved-stub',150000),('via-hole','reserved-stub',250000)]:
                hits={hit}
                with self.assertRaisesRegex(a.NativeError,'reserved GND stub clearance'):
                    a.check_reserved_clearance(board,pcb)

    def test_reserved_via_checks_both_layers_drill_and_excludes_own_hole(self):
        class Shape:
            def __init__(self,name):self.name=name
            def Collide(self,other,gap=0):return (self.name,other.name,gap) in hits
        class Via:
            m_Uuid=types.SimpleNamespace(AsString=lambda:'reserved-uuid')
            def IsLocked(self):return True
            def GetNetname(self):return 'GND'
            def GetEffectiveShape(self,layer):return Shape('land')
            def GetEffectiveHoleShape(self):return Shape('self-hole')
        pcb=types.SimpleNamespace(F_Cu=0,B_Cu=2,SHAPE=Shape,SHAPE_POLY_SET=type('Poly',(),{}),PCB_VIA=Via)
        guard=types.SimpleNamespace(layers=(0,2),clearance=150000,hole_clearance=250000,inside_edges=lambda shape:True,
            pads=[],holes=[(Shape('self-hole'),True)],other={0:[],2:[Shape('back-track')]})
        board=types.SimpleNamespace(GetTracks=lambda:[Via()],GetFootprints=lambda:[])
        hits={('self-hole','self-hole',250000)}
        with patch.object(a,'GroundClearance',return_value=guard):
            a.check_reserved_clearance(board,pcb) # Self must not trigger hole-spacing rejection.
            for hit in [('back-track','land',150000),('back-track','self-hole',250000)]:
                hits={hit}
                with self.assertRaisesRegex(a.NativeError,'reserved via clearance'):
                    a.check_reserved_clearance(board,pcb)

    def test_passive_major_axis_and_inner_via_conflict_stagger(self):
        c1=(12700000,12080000);c2=(14700000,12080000)
        pairs=a.opposite_escape_pairs(c2,(560000,620000),270)
        self.assertEqual(pairs[1],((15500000,12080000),(13900000,12080000)))
        self.assertEqual(13900000-13500000,400000) # illegal adjacent inner via centers.
        # Prior C1 innerlandbbox+[.1trackhalf+.15clearance] gives x14.05 bound.
        obstacles=[(12950000,11530000,14050000,12630000)]
        via_boxes=[(12900000,11480000,14100000,12680000),
                   (13940000,10390000,15460000,11850000)]
        choices=a.dogleg_escape_candidates(c2,(560000,620000),270,1,obstacles,via_boxes)
        self.assertTrue(choices)
        for corner,end in choices:self.assertEqual(corner,(14070000,12080000))
        legal=[end for corner,end in choices if a.math.hypot(end[0]-13500000,end[1]-12080000)>600000 and end[1]>12080000]
        self.assertTrue(legal)
        # Vertical supplypad is above and not on either passive's world-X firstleg.
        self.assertGreater(12080000-100000-11400000,150000)

    def test_v3_reservation_planner_is_lexical_bounded_and_never_backtracks(self):
        tasks=[(str(i),0) for i in range(10)]
        calls=[]
        def evaluate(task,candidate,prefix):
            calls.append((task,candidate,len(prefix)))
            return {'task':task} if candidate==23 else None
        planned,count=a.bounded_escape_plan(tasks,lambda task,prefix:list(range(24)),evaluate)
        self.assertEqual(count,240);self.assertEqual(len(planned),10)
        self.assertEqual(len(calls),240)
        with self.assertRaisesRegex(a.NativeError,'order/bound'):
            a.bounded_escape_plan(list(reversed(tasks)),lambda *args:[],evaluate)
        with self.assertRaisesRegex(a.NativeError,'candidate cap'):
            a.bounded_escape_plan(tasks,lambda *args:list(range(25)),evaluate)
        visited=[]
        def blocked(task,candidate,prefix):
            visited.append((task,candidate))
            if task=='A':return {'choice':candidate}
            return None if prefix[0]['choice']==0 else {'choice':candidate}
        with self.assertRaisesRegex(a.NativeError,'no legal opposite'):
            a.bounded_escape_plan(['A','B'],lambda *args:[0,1],blocked)
        self.assertEqual(visited,[('A',0),('B',0),('B',1)]) # Never revisits A=1.

    def test_connectivity_unavailable_is_unknown_not_zero(self):
        board=types.SimpleNamespace(BuildConnectivity=lambda:False)
        self.assertEqual(a.connectivity(board)['unrouted'],None)
        self.assertFalse(a.connectivity(board)['available'])
        conn=types.SimpleNamespace(RecalculateRatsnest=lambda:None,GetUnconnectedCount=lambda visible:3)
        board=types.SimpleNamespace(BuildConnectivity=lambda:True,GetConnectivity=lambda:conn)
        self.assertEqual(a.connectivity(board)['unrouted'],3)

    def test_failed_ses_import_cannot_publish_or_fill(self):
        input_path=self.root/'input.json'
        a.write_json(input_path,self.data)
        (self.root/'board.kicad_pcb').write_text('mock prepared board')
        (self.root/'board.dsn').write_text('mock dsn')
        ses=self.root/'board.ses'
        ses.write_text('mock failed ses')
        baseline={'version':1,'stage':'prepared','inputSha256':a.digest(input_path),
            'boardSha256':a.digest(self.root/'board.kicad_pcb'),'dsnSha256':a.digest(self.root/'board.dsn'),
            'projectSha256':a.digest(self.root/'board.kicad_pro'),'tableSha256':a.digest(self.root/'fp-lib-table'),'identity':{},'reservedCopper':[]}
        a.write_json(self.root/'prepared-evidence.json',baseline)
        pcb=types.SimpleNamespace(LoadBoard=lambda p:object(),ImportSpecctraSES=lambda b,s:False)
        with patch.object(a,'identity',return_value={}), patch.object(a,'assert_reserved'), patch.object(a,'fill_ground') as fill:
            with self.assertRaisesRegex(a.NativeError,'SES import failed'):
                a.import_session(self.data,input_path,self.root,ses,pcb)
            fill.assert_not_called()
        self.assertFalse((self.root/'native-evidence.json').exists())
        self.assertFalse((self.root/'final-board.kicad_pcb').exists())

    def test_import_and_finish_are_distinct_process_phases(self):
        input_path=self.root/'input.json'
        a.write_json(input_path,self.data)
        (self.root/'board.kicad_pcb').write_text('prepared')
        (self.root/'board.dsn').write_text('dsn')
        ses=self.root/'board.ses'
        ses.write_text('session')
        baseline={'version':1,'stage':'prepared','inputSha256':a.digest(input_path),
            'boardSha256':a.digest(self.root/'board.kicad_pcb'),'dsnSha256':a.digest(self.root/'board.dsn'),
            'projectSha256':a.digest(self.root/'board.kicad_pro'),'tableSha256':a.digest(self.root/'fp-lib-table'),'identity':{},'reservedCopper':[]}
        a.write_json(self.root/'prepared-evidence.json',baseline)
        loads=[]
        pcb=types.SimpleNamespace(LoadBoard=lambda p:loads.append(p) or object(),ImportSpecctraSES=lambda b,s:True,
            SaveBoard=lambda p,b:pathlib.Path(p).write_text('imported'))
        with patch.object(a,'identity',return_value={}),patch.object(a,'assert_reserved'):
            result=a.import_session(self.data,input_path,self.root,ses,pcb)
        self.assertEqual(result['stage'],'imported')
        self.assertEqual(len(loads),1) # Never reload in SES import process.
        self.assertTrue((self.root/'import-evidence.json').exists())
        self.assertFalse((self.root/'native-evidence.json').exists())
        self.assertFalse((self.root/'final-board.kicad_pcb').exists())
        (self.root/'imported-board.kicad_pcb').write_text('tampered')
        with self.assertRaisesRegex(a.NativeError,'import artifact hash mismatch'):
            a.finish(self.data,input_path,self.root,ses,None)
        self.assertEqual(len(loads),1) # Hash failure before fresh native load.

    def test_fill_and_inspect_are_distinct_hash_bound_phases(self):
        input_path=self.root/'input.json'
        a.write_json(input_path,self.data)
        imported=self.root/'imported-board.kicad_pcb'
        imported.write_text('imported')
        ses=self.root/'board.ses'
        ses.write_text('ses')
        baseline={'identity':{},'reservedCopper':[]}
        previous={'version':1,'stage':'imported','inputSha256':'input','preparedBoardSha256':'prepared',
            'dsnSha256':'dsn','sesSha256':'ses','importedBoardSha256':a.digest(imported)}
        loads=[]
        pcb=types.SimpleNamespace(LoadBoard=lambda p:loads.append(p) or object(),
            SaveBoard=lambda p,b:pathlib.Path(p).write_text('filled'))
        with patch.object(a,'imported_inputs',return_value=(baseline,previous,imported,ses)), \
             patch.object(a,'identity',return_value={}),patch.object(a,'assert_reserved'),patch.object(a,'check_reserved_clearance'), \
             patch.object(a,'check_topology'),patch.object(a,'fill_ground',return_value={'version':1}):
            result=a.finish(self.data,input_path,self.root,ses,pcb)
            self.assertEqual(result['stage'],'filled')
            self.assertEqual(loads,[str(imported)]) # No final reload after fill/save.
            self.assertFalse((self.root/'native-evidence.json').exists())
            self.assertTrue((self.root/'fill-evidence.json').exists())
            (self.root/'final-board.kicad_pcb').write_text('tampered')
            with self.assertRaisesRegex(a.NativeError,'fill artifact hash mismatch'):
                a.inspect(self.data,input_path,self.root,ses,None)
            self.assertEqual(len(loads),1)

    def test_drc_api_diagnostic_native_report_not_cli_pass(self):
        input_path=self.root/'input.json'
        a.write_json(input_path,self.data)
        (self.root/'final-board.kicad_pcb').write_text('final board')
        (self.root/'final-board.kicad_pro').write_text('{}')
        report='** Drc report for final-board.kicad_pcb **\n** Found 2 DRC violations **\n** Found 4 unconnected pads **\n** Found 0 Footprint errors **\n** End of Report **\n'
        calls=[]
        def native_report(board,path,units,all_errors):
            calls.append((units,all_errors));pathlib.Path(path).write_text(report);return True
        pcb=types.SimpleNamespace(Version=lambda:'10.0.1',LoadBoard=lambda p:object(),WriteDRCReport=native_report,EDA_UNITS_MM=0)
        with patch.object(a,'check_topology'):
            result=a.drc_api(self.data,input_path,self.root,pcb)
        self.assertEqual(result['stage'],'drc-api-diagnostic')
        evidence=a.read_json(self.root/'drc-api-evidence.json')
        self.assertEqual(evidence['sectionCounts'],{'violations':2,'unconnected':4,'footprintErrors':0})
        self.assertEqual(evidence['cliDrcStatus'],'not-established')
        self.assertEqual(evidence['schematicParity'],'not-run')
        self.assertEqual(calls,[(0,True)])
        self.assertTrue(evidence['persistedInputsUnchanged'])
        (self.root/'drc-api.txt').unlink();(self.root/'drc-api-evidence.json').unlink()
        report='incomplete'
        with patch.object(a,'check_topology'),self.assertRaisesRegex(a.NativeError,'incomplete'):
            a.drc_api(self.data,input_path,self.root,pcb)
        self.assertFalse((self.root/'drc-api-evidence.json').exists())

    def test_stage_journal_is_fixed_bounded_and_append_only(self):
        a.stage(self.root,'finish-start')
        a.stage(self.root,'before-zone-fill')
        entries=[json.loads(line) for line in (self.root/'native-stage.jsonl').read_text().splitlines()]
        self.assertEqual([e['stage'] for e in entries],['finish-start','before-zone-fill'])
        with self.assertRaisesRegex(a.NativeError,'unknown native journal'):
            a.stage(self.root,'/private/arbitrary-input')
        (self.root/'native-stage.jsonl').write_text('x'*8193)
        with self.assertRaisesRegex(a.NativeError,'oversized'):
            a.stage(self.root,'filled')

    def test_model_vector_copy_assignment_preserves_exact_transform(self):
        v=lambda x,y,z:types.SimpleNamespace(x=x,y=y,z=z)
        model=types.SimpleNamespace(m_Filename='source.step',m_Offset=v(.015,-.035,0),m_Scale=v(1,1,1),
            m_Rotation=v(0,0,0),m_Show=True,m_Opacity=1)
        class CopyVector:
            def __init__(self): self.data=[copy.deepcopy(model)]
            def __iter__(self): return iter(copy.deepcopy(self.data))
            def __setitem__(self,index,value): self.data[index]=copy.deepcopy(value)
        models=CopyVector()
        fp=types.SimpleNamespace(Models=lambda:models)
        read_copy=list(models)[0]
        read_copy.m_Filename='not-persisted.step'
        self.assertEqual(list(models)[0].m_Filename,'source.step')
        a.assign_model_path(fp,list(models)[0],'/owned/source.step')
        actual=a.model_identity(list(models)[0])
        self.assertEqual(actual['path'],'/owned/source.step')
        self.assertEqual(actual['offsetMm'],[.015,-.035,0])
        self.assertEqual(actual['scale'],[1,1,1])
        self.assertEqual(actual['rotationDeg'],[0,0,0])

    def test_configuration_uses_kicad10_net_settings_accessor(self):
        calls=[]
        nc=types.SimpleNamespace(**{method:(lambda value,m=method:calls.append((m,value))) for method in
            ['SetClearance','SetTrackWidth','SetViaDiameter','SetViaDrill']})
        ds=types.SimpleNamespace(m_NetSettings=types.SimpleNamespace(GetDefaultNetclass=lambda:nc))
        edges=[]
        board=types.SimpleNamespace(SetCopperLayerCount=lambda n:calls.append(('layers',n)),GetDesignSettings=lambda:ds,Add=lambda e:edges.append(e))
        shape=lambda b:types.SimpleNamespace(**{name:lambda value:None for name in ['SetShape','SetStart','SetEnd','SetLayer','SetWidth']})
        pcb=types.SimpleNamespace(FromMM=lambda n:int(n*1e6),PCB_SHAPE=shape,SHAPE_T_SEGMENT=1,Edge_Cuts=44,VECTOR2I=lambda x,y:(x,y))
        a.configure_board(board,pcb)
        self.assertEqual(len(edges),4)
        self.assertIn(('SetTrackWidth',200000),calls)
        self.assertEqual(ds.m_CopperEdgeClearance,500000)

    def test_main_records_sanitized_native_failure_and_raises(self):
        input_path=self.root/'input.json'
        a.write_json(input_path,self.data)
        with patch.dict(sys.modules,{'pcbnew':types.SimpleNamespace()}), patch.object(a,'prepare',side_effect=RuntimeError('/private/secret.py failed')):
            with self.assertRaises(RuntimeError):
                a.main(['prepare','--input',str(input_path),'--output-dir',str(self.root)])
        error=a.read_json(self.root/'native-error.json')
        self.assertEqual(error['category'],'RuntimeError')
        self.assertNotIn('/private',json.dumps(error))
        self.assertEqual(error['message'],'Native API operation failed')

    def test_prepared_hash_tamper_fails_before_native(self):
        input_path=self.root/'input.json'
        a.write_json(input_path,self.data)
        (self.root/'board.kicad_pcb').write_text('tampered')
        (self.root/'board.dsn').write_text('dsn')
        a.write_json(self.root/'prepared-evidence.json',{'version':1,'stage':'prepared','inputSha256':'bad'})
        with self.assertRaisesRegex(a.NativeError,'artifact hash mismatch'):
            a.finish(self.data,input_path,self.root,self.root/'board.ses',None)

unittest.main(argv=['astra-native-pure'],verbosity=2)
`

test('restricted native adapter pure contract and mocked failure regressions', () => {
  const result = spawnSync('python3', ['-B', '-c', suite, adapter], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stderr, /Ran 65 tests/)
})

test('adapter has no hidden native process, success sentinel override or broad pipeline imports', () => {
  const source = readFileSync(adapter, 'utf8')
  assert.doesNotMatch(source, /os\._exit|import subprocess|from subprocess|import fine_pitch_fanout|import sourcepart|import add_models/)
  assert.match(source, /pcbnew\.FootprintLoad\(/)
  assert.match(source, /sys\.exit\(1\)/)
  assert.match(source, /"drc": \{"available": False, "errors": None, "warnings": None\}/)
})
