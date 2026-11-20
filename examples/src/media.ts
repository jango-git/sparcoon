import { type BufferGeometry, Mesh, SRGBColorSpace, type Texture, TextureLoader } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type Asset = Texture | BufferGeometry;

/** The textures (`.webp`) and meshes (`.glb`) in `public/media`. Effects share files, so each one
 *  is loaded once and kept. */
export class Media {
  private readonly textureLoader = new TextureLoader();
  private readonly gltfLoader = new GLTFLoader();
  private readonly loaded = new Map<string, Promise<Asset>>();

  public constructor(private readonly base: string) {}

  /** The assets for an effect, by asset name, from the file each name is given. */
  public async load(files: Readonly<Record<string, string>>): Promise<Record<string, Asset>> {
    const entries = Object.entries(files);
    const assets = await Promise.all(entries.map(([, file]) => this.file(file)));
    return Object.fromEntries(entries.map(([name], index) => [name, assets[index]!]));
  }

  private file(file: string): Promise<Asset> {
    let asset = this.loaded.get(file);
    if (asset === undefined) {
      asset = file.endsWith(".glb") ? this.geometry(file) : this.texture(file);
      this.loaded.set(file, asset);
    }
    return asset;
  }

  private async texture(file: string): Promise<Texture> {
    const texture = await this.textureLoader.loadAsync(this.base + file);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }

  private async geometry(file: string): Promise<BufferGeometry> {
    const gltf = await this.gltfLoader.loadAsync(this.base + file);
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
}
