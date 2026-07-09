'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCcw, ArrowUp, ArrowDown } from 'lucide-react'

/**
 * Full 3D PCBA review: loads the run's board as a GLB (exported on demand from
 * variant.kicad_pcb by /api/board3d) into a three.js scene with orbit
 * controls — drag to rotate, scroll to zoom, right-drag / two-finger drag to
 * pan. Falls back to `fallback` (the raytraced renders) when the run kept no
 * .kicad_pcb to export from.
 */

type Phase = 'loading' | 'ready' | 'error'

// imperative viewer API handed back from the setup effect
interface ViewerApi {
  setSide: (side: 'top' | 'bottom') => void
  reset: () => void
  dispose: () => void
}

export function Board3D({ basePath, fallback }: { basePath: string; fallback: ReactNode }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<ViewerApi | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let disposed = false
    setPhase('loading')

    ;(async () => {
      const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/controls/OrbitControls.js'),
      ])

      const res = await fetch(`/api/board3d?base=${encodeURIComponent(basePath)}`)
      if (!res.ok) {
        const msg = await res
          .json()
          .then((j) => j.error)
          .catch(() => `HTTP ${res.status}`)
        throw new Error(msg)
      }
      const buf = await res.arrayBuffer()
      const mount = mountRef.current
      if (disposed || !mount) return

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x07090c)

      const gltf = await new GLTFLoader().parseAsync(buf, '')
      scene.add(gltf.scene)

      // frame the board: KiCad GLBs are Y-up, board thickness along Y
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const span = Math.max(size.x, size.z)

      const camera = new THREE.PerspectiveCamera(
        40,
        mount.clientWidth / Math.max(1, mount.clientHeight),
        span / 100,
        span * 40,
      )

      const renderer = new THREE.WebGLRenderer({ antialias: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05
      renderer.outputColorSpace = THREE.SRGBColorSpace
      mount.appendChild(renderer.domElement)

      // image-based lighting → glossy soldermask + metal highlights (the Flux look)
      try {
        const { RoomEnvironment } = await import(
          'three/examples/jsm/environments/RoomEnvironment.js')
        const pmrem = new THREE.PMREMGenerator(renderer)
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
      } catch { /* analytic lights alone still render fine */ }

      // real geometry casts + receives shadows
      gltf.scene.traverse((o: any) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true }
      })

      scene.add(new THREE.AmbientLight(0xffffff, 0.35))
      const key = new THREE.DirectionalLight(0xffffff, 2.4)
      key.position.set(center.x + span * 0.5, center.y + span * 1.4, center.z + span * 0.7)
      key.target.position.copy(center)
      key.castShadow = true
      key.shadow.mapSize.set(2048, 2048)
      key.shadow.bias = -0.0004
      const sc: any = key.shadow.camera
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

      const controls = new OrbitControls(camera, renderer.domElement)
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
      const loop = () => {
        raf = requestAnimationFrame(loop)
        controls.update()
        renderer.render(scene, camera)
      }
      loop()

      const onResize = () => {
        const w = mount.clientWidth
        const h = mount.clientHeight
        if (!w || !h) return
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h)
      }
      const ro = new ResizeObserver(onResize)
      ro.observe(mount)

      apiRef.current = {
        setSide: (side) => goto(side),
        reset: () => goto('top'),
        dispose: () => {
          cancelAnimationFrame(raf)
          ro.disconnect()
          controls.dispose()
          renderer.dispose()
          renderer.domElement.remove()
          scene.traverse((o: any) => {
            o.geometry?.dispose?.()
            const mats = Array.isArray(o.material) ? o.material : [o.material]
            mats.forEach((m: any) => m?.dispose?.())
          })
        },
      }
      setPhase('ready')
    })().catch((e) => {
      if (!disposed) {
        setError(String(e?.message ?? e))
        setPhase('error')
      }
    })

    return () => {
      disposed = true
      apiRef.current?.dispose()
      apiRef.current = null
    }
  }, [basePath])

  if (phase === 'error')
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-500/90">
          3D model unavailable ({error}) — showing raytraced renders instead
        </div>
        <div className="min-h-0 flex-1">{fallback}</div>
      </div>
    )

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={mountRef} className="h-full w-full" />

      {phase === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#07090c]">
          <div className="size-5 animate-spin rounded-full border-2 border-border border-t-primary" />
          <p className="font-mono text-[10px] text-muted-foreground">
            building 3D model from variant.kicad_pcb… first open takes ~10 s
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
