/**
 * Compiles against the built package (`dist`) as a game does, so the published declarations are
 * checked against the installed `@types/three`. Covers the calls the README shows. It is never run.
 */
import {
  BufferGeometry,
  Data3DTexture,
  DepthTexture,
  Group,
  PerspectiveCamera,
  RedFormat,
  Scene,
  Texture,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import {
  FX_RUNTIME_VERSION,
  FXEffect,
  type FXEffectOptions,
  type FXEmitter,
  type FXExternalTexture,
  FXWorld,
  fxAtlasRegion,
  fxSetCameraDepth,
} from "sparcoon";
import * as editor from "sparcoon/editor";
import * as helpers from "sparcoon/helpers";

declare const renderer: WebGLRenderer;

/** The interface of an exported effect's assets, as the editor writes it. */
interface SampleEffectAssets {
  tGlow: FXExternalTexture;
  tSmoke: FXExternalTexture;
  Chunk: BufferGeometry;
}

/** The class an exported module declares. Its body is not type-checked (`@ts-nocheck`), so only
 *  this signature reaches the game's code. */
declare class SampleEffect extends FXEffect {
  public constructor(assets: SampleEffectAssets, options?: FXEffectOptions);
}

const camera = new PerspectiveCamera();
const scene = new Scene();
const texture = new Texture();
const assets: SampleEffectAssets = {
  tGlow: texture,
  tSmoke: fxAtlasRegion(texture, { frame: { x: 0, y: 0, w: 8, h: 8 } }, { w: 64, h: 64 }),
  Chunk: new BufferGeometry(),
};

const effect = new SampleEffect(assets, { renderer, camera });
scene.add(effect);
effect.play();
effect.play({ loop: false });
effect.addEventListener("finished", () => {});
const onDrained = (): void => {
  effect.removeEventListener("drained", onDrained);
  effect.dispose();
};
effect.addEventListener("drained", onDrained);
effect.position.copy(new Vector3());
effect.removeFromParent();
effect.stop();
void effect.compile(renderer, camera, scene).then(() => effect.simulationReady());
effect.setEmitterParam("Sparks", "color", [1, 0.4, 0.1]);

const sparks: FXEmitter | undefined = effect.getEmitter("Sparks");
if (sparks !== undefined) {
  sparks.burst(64);
  sparks.burst(16, { origin: { position: [2, 1, 0] } });
  sparks.play(120);
  sparks.play(8, { over: "distance" });
  sparks.stop();
  sparks.prewarm(2);
  sparks.position.set(0, 1, 0);
  const unsubscribe = sparks.onParticleEvent("death", (death) => death.position);
  unsubscribe();
  if (sparks.sort !== undefined) {
    sparks.camera = camera;
    sparks.sort.fraction = 0.25;
  }
  const counts: number = sparks.particleCount + sparks.particleCapacity;
  void counts;
}

const depthPass = new WebGLRenderTarget(4, 4, { depthTexture: new DepthTexture(4, 4) });
fxSetCameraDepth(camera, depthPass.depthTexture);
fxSetCameraDepth(camera, undefined);

const effects = new Group();
effects.add(effect);

const sdf = new Data3DTexture(new Uint8Array(8), 2, 2, 2);
sdf.format = RedFormat;
sdf.type = UnsignedByteType;

const slowMotion = new FXWorld();
slowMotion.update(0.016);
FXWorld.update(0.016);
slowMotion.dispose();

const version: string = FX_RUNTIME_VERSION;
void [version, editor, helpers, sdf];
