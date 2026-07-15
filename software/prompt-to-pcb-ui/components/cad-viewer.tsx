'use client'

/**
 * Real-CAD orbit viewer — loads the Onshape-exported enclosure glTF (the same
 * geometry as the downloadable STEP) into an interactive three.js scene, so the
 * generated CAD gets the same drag-to-rotate treatment as the PCBA instead of a
 * flat white JPEG. Dark scene matches the app theme. Display-only: the
 * tolerance gate stays the STEP + the honest fitCheck, not this view.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

export function CadViewer({ url }: { url: string }) {
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
        const res = await fetch(url)
        if (!res.ok) throw new Error(`CAD model HTTP ${res.status}`)
        const buf = await res.arrayBuffer()
        const mount = mountRef.current
        if (disposed || !mount) return

        const scene = new THREE.Scene()
        scene.background = new THREE.Color(0x0f0f0f)

        const gltf = await new GLTFLoader().parseAsync(buf, '')
        const part = gltf.scene
        // Uniform neutral part shading, like a CAD package's default material.
        // Onshape's per-part appearances arrive as blown-out whites and its
        // default pale blue (unset parts) — on a dark scene they read as glare,
        // and no per-material normalization handled both (verified in a live
        // harness). One matte grey is deterministic and reads like a product.
        const neutral = new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.6, metalness: 0.05 })
        part.traverse((o: any) => {
          if (o.isMesh) {
            o.castShadow = true; o.receiveShadow = true
            o.material = neutral
          }
        })
        scene.add(part)

        const box = new THREE.Box3().setFromObject(part)
        const sz = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const span = Math.max(sz.x, sz.y, sz.z) || 1

        const camera = new THREE.PerspectiveCamera(40, mount.clientWidth / Math.max(1, mount.clientHeight), span / 100, span * 40)
        renderer = new THREE.WebGLRenderer({ antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.setSize(mount.clientWidth, mount.clientHeight)
        renderer.shadowMap.enabled = true
        renderer.shadowMap.type = THREE.PCFSoftShadowMap
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 0.75
        renderer.outputColorSpace = THREE.SRGBColorSpace
        mount.appendChild(renderer.domElement)

        try {
          const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js')
          const pmrem = new THREE.PMREMGenerator(renderer)
          scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
          ;(scene as any).environmentIntensity = 0.12
        } catch { /* analytic lights alone still render */ }

        scene.add(new THREE.AmbientLight(0xffffff, 0.35))
        const key = new THREE.DirectionalLight(0xffffff, 2.0)
        key.position.set(center.x + span, center.y + span * 1.4, center.z + span * 0.7)
        key.target.position.copy(center); key.castShadow = true
        key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004
        const scam: any = key.shadow.camera; const d = span * 0.9
        scam.left = -d; scam.right = d; scam.top = d; scam.bottom = -d; scam.near = span * 0.05; scam.far = span * 8; scam.updateProjectionMatrix()
        scene.add(key, key.target)
        const fill = new THREE.DirectionalLight(0xbfd4ff, 0.45)
        fill.position.set(center.x - span, center.y + span * 0.4, center.z - span)
        scene.add(fill)

        const floorY = box.min.y - span * 0.01
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8), new THREE.ShadowMaterial({ opacity: 0.4 }))
        ground.rotation.x = -Math.PI / 2; ground.position.set(center.x, floorY, center.z); ground.receiveShadow = true
        scene.add(ground)
        const grid = new THREE.GridHelper(span * 8, 32, 0x2a2a2c, 0x1a1a1c)
        grid.position.set(center.x, floorY, center.z)
        scene.add(grid)

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.target.copy(center); controls.enableDamping = true; controls.dampingFactor = 0.08
        controls.minDistance = span * 0.15; controls.maxDistance = span * 6
        const sphere = box.getBoundingSphere(new THREE.Sphere())
        const fit = sphere.radius / Math.sin((camera.fov / 2) * Math.PI / 180) * 1.25
        camera.position.set(center.x + fit * 0.5, center.y + fit * 0.55, center.z + fit * 0.75)
        camera.lookAt(center); controls.update()

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
  }, [url])

  return (
    <div className="relative h-full w-full">
      <div ref={mountRef} className="h-full w-full" />
      {phase === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> loading CAD…
        </div>
      )}
      {phase === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-destructive">
          CAD viewer failed: {err}
        </div>
      )}
    </div>
  )
}
