'use client'

/**
 * Final-product assembly viewer — the populated chip-scale PCBA (loaded from the
 * board3d GLB) sitting inside the generated enclosure, with the Li-ion cell. The
 * enclosure is a translucent shell sized from the real board's bounding box (walls
 * + head/tail room for components and the cell), so you see the whole product
 * assembled, not just the bare board. Interactive (orbit). Approximate shell for
 * visualization — the tolerance-validated CAD is the downloadable STEP.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

export function MechanicalAssembly({ basePath }: { basePath: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState('')

  useEffect(() => {
    let disposed = false
    let renderer: any = null
    let raf = 0
    setPhase('loading'); setErr('')

    ;(async () => {
      try {
        const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/controls/OrbitControls.js'),
        ])
        const res = await fetch(`/api/board3d?base=${encodeURIComponent(basePath)}`)
        if (!res.ok) throw new Error(await res.json().then((j) => j.error).catch(() => `HTTP ${res.status}`))
        const buf = await res.arrayBuffer()
        const mount = mountRef.current
        if (disposed || !mount) return

        const scene = new THREE.Scene()
        scene.background = new THREE.Color(0x07090c)

        const gltf = await new GLTFLoader().parseAsync(buf, '')
        const boardGrp = gltf.scene
        boardGrp.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })

        // board bbox (KiCad GLB is Y-up: X,Z = footprint, Y = height/components)
        const box = new THREE.Box3().setFromObject(boardGrp)
        const sz = box.getSize(new THREE.Vector3())
        const c = box.getCenter(new THREE.Vector3())
        const wall = Math.max(1.0, Math.min(sz.x, sz.z) * 0.06)   // enclosure wall
        const cell = Math.max(3.0, Math.min(sz.x, sz.z) * 0.35)   // Li-ion cell height
        const gap = 0.6

        const asm = new THREE.Group()
        // board sits with its underside a wall+cell above the enclosure floor
        const boardLiftY = (box.min.y) // keep board where it is; build shell around it
        asm.add(boardGrp)

        // Li-ion cell: a dark box under the board
        const cellW = sz.x * 0.62, cellD = sz.z * 0.62
        const cellMesh = new THREE.Mesh(
          new THREE.BoxGeometry(cellW, cell, cellD),
          new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.5, roughness: 0.45 }))
        cellMesh.position.set(c.x, box.min.y - gap - cell / 2, c.z)
        cellMesh.castShadow = true; cellMesh.receiveShadow = true
        asm.add(cellMesh)

        // translucent enclosure shell wrapping board + cell
        const encW = sz.x + wall * 2, encD = sz.z + wall * 2
        const innerBottom = box.min.y - gap - cell - gap
        const innerTop = box.max.y + gap
        const encH = (innerTop - innerBottom) + wall * 2
        const encCenterY = (innerTop + innerBottom) / 2
        const shell = new THREE.Mesh(
          new THREE.BoxGeometry(encW, encH, encD),
          new THREE.MeshPhysicalMaterial({
            color: 0x9fb4cc, transparent: true, opacity: 0.16,
            roughness: 0.15, metalness: 0, transmission: 0.6,
            side: THREE.DoubleSide, depthWrite: false,
          }))
        shell.position.set(c.x, encCenterY, c.z)
        asm.add(shell)
        // crisp edge lines so the enclosure reads clearly through the translucency
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(encW, encH, encD)),
          new THREE.LineBasicMaterial({ color: 0xbcd0e6, transparent: true, opacity: 0.5 }))
        edges.position.copy(shell.position)
        asm.add(edges)

        scene.add(asm)

        // frame the whole assembly
        const abox = new THREE.Box3().setFromObject(asm)
        const asz = abox.getSize(new THREE.Vector3())
        const acenter = abox.getCenter(new THREE.Vector3())
        const span = Math.max(asz.x, asz.y, asz.z)

        const camera = new THREE.PerspectiveCamera(40, mount.clientWidth / Math.max(1, mount.clientHeight), span / 100, span * 40)
        renderer = new THREE.WebGLRenderer({ antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.setSize(mount.clientWidth, mount.clientHeight)
        renderer.shadowMap.enabled = true
        renderer.shadowMap.type = THREE.PCFSoftShadowMap
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.outputColorSpace = THREE.SRGBColorSpace
        mount.appendChild(renderer.domElement)

        try {
          const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js')
          const pmrem = new THREE.PMREMGenerator(renderer)
          scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
        } catch { /* analytic lights alone still render */ }

        scene.add(new THREE.AmbientLight(0xffffff, 0.3))
        const key = new THREE.DirectionalLight(0xffffff, 2.6)
        key.position.set(acenter.x + span, acenter.y + span * 1.4, acenter.z + span * 0.7)
        key.target.position.copy(acenter); key.castShadow = true
        key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004
        const scam: any = key.shadow.camera; const d = span * 0.9
        scam.left = -d; scam.right = d; scam.top = d; scam.bottom = -d; scam.near = span * 0.05; scam.far = span * 8; scam.updateProjectionMatrix()
        scene.add(key, key.target)
        scene.add(Object.assign(new THREE.DirectionalLight(0xbfd4ff, 0.5), { position: new THREE.Vector3(acenter.x - span, acenter.y + span * 0.4, acenter.z - span) }))

        const floorY = abox.min.y - span * 0.01
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8), new THREE.ShadowMaterial({ opacity: 0.4 }))
        ground.rotation.x = -Math.PI / 2; ground.position.set(acenter.x, floorY, acenter.z); ground.receiveShadow = true
        scene.add(ground)
        scene.add(Object.assign(new THREE.GridHelper(span * 8, 32, 0x1b2530, 0x0f141b), { position: new THREE.Vector3(acenter.x, floorY, acenter.z) }))

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.target.copy(acenter); controls.enableDamping = true; controls.dampingFactor = 0.08
        controls.minDistance = span * 0.15; controls.maxDistance = span * 6
        const sphere = abox.getBoundingSphere(new THREE.Sphere())
        const fit = sphere.radius / Math.sin((camera.fov / 2) * Math.PI / 180) * 1.25
        camera.position.set(acenter.x + fit * 0.5, acenter.y + fit * 0.55, acenter.z + fit * 0.75)
        camera.lookAt(acenter); controls.update()

        setPhase('ready')
        const loop = () => { if (disposed) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop) }
        loop()

        const onResize = () => {
          if (!mount) return
          camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight); camera.updateProjectionMatrix()
          renderer.setSize(mount.clientWidth, mount.clientHeight)
        }
        window.addEventListener('resize', onResize)
        ;(mount as any).__cleanup = () => window.removeEventListener('resize', onResize)
      } catch (e) { if (!disposed) { setErr(String(e)); setPhase('error') } }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      const mount = mountRef.current as any
      mount?.__cleanup?.()
      if (renderer) { try { renderer.dispose(); renderer.domElement?.remove() } catch { /* */ } }
    }
  }, [basePath])

  return (
    <div className="relative h-full w-full">
      <div ref={mountRef} className="h-full w-full" />
      {phase === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> building the final assembly…
        </div>
      )}
      {phase === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-destructive">{err || 'assembly unavailable'}</div>
      )}
    </div>
  )
}
