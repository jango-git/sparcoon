import type { Blending, InstancedBufferGeometry, ShaderMaterial, Vector2 } from "three";
import { InstancedBufferAttribute, Mesh, StreamDrawUsage } from "three";
import { BUILTIN_OFFSET_AGE, BUILTIN_OFFSET_LIFETIME } from "../miscellaneous/miscellaneous";
import { buildParticleMaterial, INSTANCED_PARTICLE_GEOMETRY } from "./FXInstancedParticle.Internal";
import { resolvePropertyUniform, type GLProperty, type GLTypeInfo } from "./shared";

export class FXInstancedParticle extends Mesh {
  public readonly propertyBuffers: Record<string, InstancedBufferAttribute> = {};

  private readonly instancedGeometry: InstancedBufferGeometry;
  private readonly shaderMaterial: ShaderMaterial;
  private capacity: number;

  constructor(
    sources: string[],
    uniforms: Record<string, GLProperty>,
    varyings: Record<string, GLTypeInfo>,
    expectedCapacity: number,
    private readonly capacityStep: number,
    blending: Blending,
  ) {
    const instancedGeometry = INSTANCED_PARTICLE_GEOMETRY.clone();
    const shaderMaterial = buildParticleMaterial(sources, uniforms, varyings, blending);

    super(instancedGeometry, shaderMaterial);

    this.frustumCulled = false;
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;

    this.instancedGeometry = instancedGeometry;
    this.instancedGeometry.instanceCount = 0;

    this.shaderMaterial = shaderMaterial;
    this.capacity = Math.max(
      Math.ceil(expectedCapacity / this.capacityStep) * this.capacityStep,
      this.capacityStep,
    );

    for (const name in varyings) {
      const { bufferSize } = varyings[name];
      const attribute = new InstancedBufferAttribute(
        new Float32Array(this.capacity * bufferSize),
        bufferSize,
      );
      attribute.setUsage(StreamDrawUsage);
      this.instancedGeometry.setAttribute(`a_${name}`, attribute);
      this.propertyBuffers[name] = attribute;
    }
  }

  public get instanceCount(): number {
    return this.instancedGeometry.instanceCount;
  }

  public createInstances(count: number): void {
    const currentInstanceCount = this.instancedGeometry.instanceCount;
    this.ensureCapacity(currentInstanceCount + count);
    this.instancedGeometry.instanceCount += count;
  }

  public setOrigin(x: number, y: number): void {
    const uniform = resolvePropertyUniform("origin", this.shaderMaterial);
    (uniform.value as Vector2).set(x, y);
  }

  public removeDeadParticles(): void {
    const builtinBuffer = this.propertyBuffers.builtin as InstancedBufferAttribute | undefined;
    if (builtinBuffer === undefined) {
      return;
    }

    const { array: builtinArray, itemSize: builtinItemSize } = builtinBuffer;
    const { instanceCount } = this.instancedGeometry;

    let writeIndex = 0;

    for (let readIndex = 0; readIndex < instanceCount; readIndex++) {
      const offset = readIndex * builtinItemSize;

      if (
        builtinArray[offset + BUILTIN_OFFSET_AGE] < builtinArray[offset + BUILTIN_OFFSET_LIFETIME]
      ) {
        if (writeIndex !== readIndex) {
          for (const name in this.propertyBuffers) {
            const attribute = this.propertyBuffers[name];
            const { itemSize: dataItemSize, array: dataArray } = attribute;

            const srcOffset = readIndex * dataItemSize;
            const dstOffset = writeIndex * dataItemSize;

            dataArray.copyWithin(dstOffset, srcOffset, srcOffset + dataItemSize);
            attribute.needsUpdate = true;
          }
        }

        writeIndex++;
      }
    }

    this.instancedGeometry.instanceCount = writeIndex;
  }

  public drop(): void {
    this.instancedGeometry.instanceCount = 0;
  }

  public destroy(): void {
    this.instancedGeometry.dispose();
    this.shaderMaterial.dispose();
  }

  private ensureCapacity(requiredCapacity: number): void {
    if (requiredCapacity <= this.capacity) {
      return;
    }

    const newCapacity = Math.ceil(requiredCapacity / this.capacityStep) * this.capacityStep;

    for (const name in this.propertyBuffers) {
      const { itemSize, array, usage } = this.propertyBuffers[name];
      const newArray = new Float32Array(newCapacity * itemSize);
      newArray.set(array);

      const newAttribute = new InstancedBufferAttribute(newArray, itemSize);
      newAttribute.setUsage(usage);
      this.instancedGeometry.setAttribute(`a_${name}`, newAttribute);
      this.propertyBuffers[name] = newAttribute;
    }

    this.capacity = newCapacity;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- old three.js compatibility fix
    (this.instancedGeometry as any)._maxInstanceCount = newCapacity;
  }
}
