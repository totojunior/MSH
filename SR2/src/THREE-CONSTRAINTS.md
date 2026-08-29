# three.js target (verified by HTTP probe, 2026-08-28)

PINNED: https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js
  - 615,601 bytes, UMD, sets globalThis.THREE
  - r134 is the NEWEST UMD `three.min.js` on cdnjs. r135+ return 404.
  - Fallback: .../three.js/r128/three.min.js (also 200)

## Confirmed present in r134 core
InstancedMesh, ACESFilmicToneMapping, sRGBEncoding, PCFSoftShadowMap, FogExp2, Fog,
PMREMGenerator, CatmullRomCurve3, TubeGeometry, ExtrudeGeometry, LatheGeometry,
CanvasTexture, DataTexture, WebGLRenderTarget, ShaderMaterial, MeshPhysicalMaterial,
MeshStandardMaterial, SpriteMaterial, PointsMaterial, CylinderGeometry, ConeGeometry,
TorusGeometry, BoxGeometry, SphereGeometry, PlaneGeometry, Raycaster, Clock, Group.

## NOT available — do not use
- THREE.CapsuleGeometry        (added r140) -> build from CylinderGeometry + 2 SphereGeometry caps
- THREE.BufferGeometryUtils    (examples/jsm, NOT in the core UMD file)
- EffectComposer / RenderPass / UnrealBloomPass / ShaderPass / FXAA (all examples/jsm)
- OrbitControls, GLTFLoader, and every other examples/jsm module
- outputColorSpace / SRGBColorSpace / ColorManagement  (r152+) -> use
  renderer.outputEncoding = THREE.sRGBEncoding
- material.color.setColorSpace, texture.colorSpace     (r152+) -> use texture.encoding = THREE.sRGBEncoding

## r134 API notes
- renderer.outputEncoding = THREE.sRGBEncoding
- renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = n
- renderer.physicallyCorrectLights exists (default false)
- Geometry parameter order: CylinderGeometry(rTop, rBottom, height, radialSeg, heightSeg, openEnded)
- WebGLRenderTarget(w, h, {minFilter, magFilter, format, type, depthBuffer, stencilBuffer})
  -> NO `samples` option in r134; there is no MSAA render target. Use a full-res target and
     do the AA in the post shader, or render the target at 1.25x and downsample.
- WebGLMultisampleRenderTarget EXISTS in r134 but is deprecated/limited; prefer plain target.
