'use client'

/**
 * Final-product assembly viewer — the populated chip-scale PCBA (board3d GLB)
 * seated inside the REAL Onshape-exported enclosure glTF (translucent), so the
 * assembly shows the actual generated CAD, not an invented box. Seating depth
 * is approximate (centered in the cavity) — the honest fit gate stays the
 * fitCheck + STEP. A battery block is drawn ONLY when the spec has one.
 * Fallback for legacy runs without a glTF: the old bbox-derived shell.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Minus, Maximize } from 'lucide-react'

export function MechanicalAssembly({ basePath, enclosureUrl, hasBattery }: {
  basePath: string
  enclosureUrl?: string | null
  hasBattery?: boolean
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [err, setErr] = useState('')
  const apiRef = useRef<{ zoom: (f: number) => void; fit: () => void } | null>(null)

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
        scene.background = new THREE.Color(0x0a0a0a)

        const gltf = await new GLTFLoader().parseAsync(buf, '')
        const boardGrp = gltf.scene
        boardGrp.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })

        // board bbox (KiCad GLB is Y-up: X,Z = footprint, Y = height/components).
        // NB: kicad-cli exports GLB in METERS (glTF convention) — a 20 mm board
        // measures ~0.02 units — so every shell dimension is derived RELATIVE to
        // the board footprint, never from absolute mm literals (a `1.0` floor
        // would be one metre and balloon the enclosure to a giant empty box).
        const box = new THREE.Box3().setFromObject(boardGrp)
        const sz = box.getSize(new THREE.Vector3())
        const c = box.getCenter(new THREE.Vector3())
        const foot = Math.max(sz.x, sz.z) || 0.02                 // board footprint span
        const wall = foot * 0.05                                  // enclosure wall ~5% of footprint
        const cell = foot * 0.35                                  // Li-ion cell height ~⅓ of footprint
        const gap = foot * 0.03                                   // component/cell clearance

        const asm = new THREE.Group()
        asm.add(boardGrp)

        // Battery: drawn ONLY when the spec actually includes one — inventing
        // a Li-ion cell under a USB-powered product was misleading.
        const contentBottom = hasBattery ? box.min.y - gap - cell : box.min.y
        if (hasBattery) {
          const cellW = sz.x * 0.62, cellD = sz.z * 0.62
          const cellMesh = new THREE.Mesh(
            new THREE.BoxGeometry(cellW, cell, cellD),
            new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.5, roughness: 0.45 }))
          cellMesh.position.set(c.x, box.min.y - gap - cell / 2, c.z)
          cellMesh.castShadow = true; cellMesh.receiveShadow = true
          asm.add(cellMesh)
        }

        let realEnclosure = false
        if (enclosureUrl) {
          // TRUE assembly: the real Onshape enclosure glTF, translucent so the
          // board reads through it. Both models are in meters (glTF convention),
          // so alignment is pure translation: center the enclosure on the board
          // in XZ, and rest the content a floor-margin above the cavity bottom
          // (seating depth approximate — the plan's boss heights aren't in the
          // exported mesh).
          try {
            const encRes = await fetch(enclosureUrl)
            if (!encRes.ok) throw new Error(`enclosure HTTP ${encRes.status}`)
            const encBuf = await encRes.arrayBuffer()
            const encGltf = await new GLTFLoader().parseAsync(encBuf, '')
            const enc = encGltf.scene
            const encMat = new THREE.MeshPhysicalMaterial({
              color: 0x93a0ae, transparent: true, opacity: 0.22,
              roughness: 0.3, metalness: 0, side: THREE.DoubleSide, depthWrite: false,
            })
            enc.traverse((o: any) => { if (o.isMesh) { o.material = encMat; o.castShadow = false; o.renderOrder = 2 } })
            const encBox = new THREE.Box3().setFromObject(enc)
            const encSz = encBox.getSize(new THREE.Vector3())
            const encC = encBox.getCenter(new THREE.Vector3())
            enc.position.x += c.x - encC.x
            enc.position.z += c.z - encC.z
            enc.position.y += (contentBottom - encSz.y * 0.15) - encBox.min.y
            asm.add(enc)
            realEnclosure = true
          } catch { /* fall through to the approximate shell below */ }
        }

        if (!realEnclosure) {
          // Legacy fallback (no glTF export): bbox-derived translucent shell.
          const encW = sz.x + wall * 2, encD = sz.z + wall * 2
          const innerBottom = contentBottom - gap
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
        }

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
        // NB: three.js makes Object3D.position read-only (defineProperties, no
        // setter), so Object.assign(light, {position}) throws — set it in place.
        const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5)
        fill.position.set(acenter.x - span, acenter.y + span * 0.4, acenter.z - span)
        scene.add(fill)

        const floorY = abox.min.y - span * 0.01
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8), new THREE.ShadowMaterial({ opacity: 0.4 }))
        ground.rotation.x = -Math.PI / 2; ground.position.set(acenter.x, floorY, acenter.z); ground.receiveShadow = true
        scene.add(ground)
        const grid = new THREE.GridHelper(span * 8, 32, 0x1b2530, 0x0f141b)
        grid.position.set(acenter.x, floorY, acenter.z)
        scene.add(grid)

        const controls = new OrbitControls(camera, renderer.domElement)
        // Wheel-over the viewer should scroll the PAGE, not zoom the scene —
        // zoom arms on click (pointerdown) and disarms when the cursor leaves,
        // so the tab stays scrollable without hunting for a gutter.
        controls.enableZoom = false
        const armZoom = () => { controls.enableZoom = true }
        const disarmZoom = () => { controls.enableZoom = false }
        renderer.domElement.addEventListener('pointerdown', armZoom)
        renderer.domElement.addEventListener('mouseleave', disarmZoom)
        controls.target.copy(acenter); controls.enableDamping = true; controls.dampingFactor = 0.08
        controls.minDistance = span * 0.15; controls.maxDistance = span * 6
        const sphere = abox.getBoundingSphere(new THREE.Sphere())
        const fit = sphere.radius / Math.sin((camera.fov / 2) * Math.PI / 180) * 1.25
        camera.position.set(acenter.x + fit * 0.5, acenter.y + fit * 0.55, acenter.z + fit * 0.75)
        camera.lookAt(acenter); controls.update()

        // Zoom buttons (same capability as wheel-zoom, no click-arming needed)
        apiRef.current = {
          zoom: (f: number) => {
            const dir = camera.position.clone().sub(controls.target)
            const len = Math.min(Math.max(dir.length() * f, controls.minDistance), controls.maxDistance)
            camera.position.copy(controls.target).add(dir.normalize().multiplyScalar(len))
            controls.update()
          },
          fit: () => {
            controls.target.copy(acenter)
            camera.position.set(acenter.x + fit * 0.5, acenter.y + fit * 0.55, acenter.z + fit * 0.75)
            camera.lookAt(acenter); controls.update()
          },
        }

        setPhase('ready')
        const loop = () => { if (disposed) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop) }
        loop()

        const onResize = () => {
          if (!mount) return
          camera.aspect = mount.clientWidth / Math.max(1, mount.clientHeight); camera.updateProjectionMatrix()
          renderer.setSize(mount.clientWidth, mount.clientHeight)
        }
        window.addEventListener('resize', onResize)
        ;(mount as any).__cleanup = () => {
          window.removeEventListener('resize', onResize)
          renderer.domElement?.removeEventListener('pointerdown', armZoom)
          renderer.domElement?.removeEventListener('mouseleave', disarmZoom)
        }
      } catch (e) { if (!disposed) { setErr(String(e)); setPhase('error') } }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      const mount = mountRef.current as any
      mount?.__cleanup?.()
      if (renderer) { try { renderer.dispose(); renderer.domElement?.remove() } catch { /* */ } }
    }
  }, [basePath, enclosureUrl, hasBattery])

  return (
    <div className="relative h-full w-full">
      <div ref={mountRef} className="h-full w-full" />
      <div className="absolute right-2 top-2 flex items-center gap-1">
        {[
          { I: Plus, act: () => apiRef.current?.zoom(1 / 1.25), label: 'zoom in' },
          { I: Minus, act: () => apiRef.current?.zoom(1.25), label: 'zoom out' },
          { I: Maximize, act: () => apiRef.current?.fit(), label: 'fit' },
        ].map(({ I, act, label }) => (
          <button key={label} type="button" onClick={act} aria-label={label} title={label}
            className="rounded-sm border border-border bg-secondary/80 p-1.5 text-muted-foreground hover:text-foreground">
            <I className="size-3.5" />
          </button>
        ))}
      </div>
      <span className="pointer-events-none absolute bottom-1.5 left-2.5 font-mono text-[9px] text-muted-foreground">
        drag to rotate · click, then scroll to zoom
      </span>
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
