import {
  type BufferGeometry,
  Data3DTexture,
  ImageLoader,
  Mesh,
  type Object3D,
  RedFormat,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  UnsignedByteType,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type Asset = Texture | BufferGeometry | Data3DTexture;

/** The size an SDF's file name carries: `Name SDF <width>x<height>x<depth>.png`. */
const SDF_SIZE = /SDF (\d+)x(\d+)x(\d+)\.png$/;

/** The textures (`.webp`, `.png`), meshes (`.glb`), SDFs (`SDF WxHxD.png`) and scenes in
 *  `public/media`. Effects share files, so each one is loaded once and kept. */
export class Media {
  private readonly textureLoader = new TextureLoader();
  private readonly imageLoader = new ImageLoader();
  private readonly gltfLoader = new GLTFLoader();
  private readonly loaded = new Map<string, Promise<Asset>>();
  private readonly scenes = new Map<string, Promise<Object3D>>();

  public constructor(private readonly base: string) {}

  /** The assets for an effect, by asset name, from the file each name is given. */
  public async load(files: Readonly<Record<string, string>>): Promise<Record<string, Asset>> {
    const entries = Object.entries(files);
    const assets = await Promise.all(entries.map(([, file]) => this.file(file)));
    return Object.fromEntries(entries.map(([name], index) => [name, assets[index]!]));
  }

  /** A scene the effect plays in, its meshes casting and receiving shadows. */
  public scene(file: string): Promise<Object3D> {
    let scene = this.scenes.get(file);
    if (scene === undefined) {
      scene = this.gltfLoader.loadAsync(this.url(file)).then((gltf) => {
        gltf.scene.traverse((object) => {
          if (object instanceof Mesh) {
            object.castShadow = true;
            object.receiveShadow = true;
          }
        });
        return gltf.scene;
      });
      this.scenes.set(file, scene);
    }
    return scene;
  }

  private file(file: string): Promise<Asset> {
    let asset = this.loaded.get(file);
    if (asset === undefined) {
      const size = SDF_SIZE.exec(file);
      asset =
        size !== null
          ? this.sdf(file, Number(size[1]), Number(size[2]), Number(size[3]))
          : file.endsWith(".glb")
            ? this.geometry(file)
            : this.texture(file);
      this.loaded.set(file, asset);
    }
    return asset;
  }

  private url(file: string): string {
    return this.base + file.split("/").map(encodeURIComponent).join("/");
  }

  private async texture(file: string): Promise<Texture> {
    const texture = await this.textureLoader.loadAsync(this.url(file));
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }

  private async geometry(file: string): Promise<BufferGeometry> {
    const gltf = await this.gltfLoader.loadAsync(this.url(file));
    let geometry: BufferGeometry | undefined;
    gltf.scene.traverse((object) => {
      if (geometry === undefined && object instanceof Mesh) {
        geometry = object.geometry as BufferGeometry;
      }
    });
    if (geometry === undefined) {
      throw new Error(`${file} holds no mesh`);
    }
    return geometry;
  }

  /**
   * An SDF from the editor's PNG of its slices: slice `z` is the tile at column `z % columns` and
   * row `floor(z / columns)`, `columns` being `ceil(sqrt(depth))` (see the README's Signed distance
   * fields).
   */
  private async sdf(
    file: string,
    width: number,
    height: number,
    depth: number,
  ): Promise<Data3DTexture> {
    const image = await this.imageLoader.loadAsync(this.url(file));
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const columns = Math.ceil(Math.sqrt(depth));
    const texels = new Uint8Array(width * height * depth);
    for (let z = 0; z < depth; z++) {
      const left = (z % columns) * width;
      const top = Math.floor(z / columns) * height;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          texels[(z * height + y) * width + x] = pixels[((top + y) * image.width + left + x) * 4]!;
        }
      }
    }
    const sdf = new Data3DTexture(texels, width, height, depth);
    sdf.format = RedFormat;
    sdf.type = UnsignedByteType;
    return sdf;
  }
}
