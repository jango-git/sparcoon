import type { Material, Vector3 } from "three";
import {
  BufferAttribute,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  StreamDrawUsage,
} from "three";
import {
  BUILTIN_OFFSET_AGE,
  BUILTIN_OFFSET_LIFETIME,
  BUILTIN_OFFSET_POSITION_X,
  BUILTIN_OFFSET_POSITION_Y,
  BUILTIN_OFFSET_POSITION_Z,
} from "../miscellaneous/miscellaneous";
import type { GLTypeInfo } from "./shared";

export class FXInstancedParticle extends Mesh {
  public readonly propertyBuffers: Record<string, InstancedBufferAttribute> = {};

  private readonly instancedGeometry: InstancedBufferGeometry;
  private readonly particleMaterial: Material;
  private capacity: number;

  private sortingIndices: Int32Array = new Int32Array(0);
  private sortingSquaredDistances: Float64Array = new Float64Array(0);
  private sortingTemporaryBuffer: Float32Array = new Float32Array(0);

  constructor(
    varyings: Record<string, GLTypeInfo>,
    expectedCapacity: number,
    private readonly capacityStep: number,
    material: Material,
  ) {
    const instancedGeometry = new InstancedBufferGeometry();

    const indices = new Uint16Array([0, 2, 1, 2, 3, 1]);
    instancedGeometry.setIndex(new BufferAttribute(indices, 1));

    const positions = new Float32Array([-0.5, 0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0]);
    instancedGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));

    const uvs = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
    instancedGeometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));

    super(instancedGeometry, material);

    this.frustumCulled = false;
    this.instancedGeometry = instancedGeometry;
    this.instancedGeometry.instanceCount = 0;

    this.particleMaterial = material;
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

  public get instanceCapacity(): number {
    return this.capacity;
  }

  public createInstances(count: number): void {
    const currentInstanceCount = this.instancedGeometry.instanceCount;
    this.ensureCapacity(currentInstanceCount + count);
    this.instancedGeometry.instanceCount += count;
  }

  public removeDeadParticles(): void {
    const builtinBuffer = this.propertyBuffers.builtin as InstancedBufferAttribute | undefined;
    if (builtinBuffer === undefined) {
      return;
    }

    const { array: builtinArray, itemSize: builtinItemSize } = builtinBuffer;
    const { instanceCount } = this.instancedGeometry;

    let writeIndex = 0;
    let didCompact = false;

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
          }

          didCompact = true;
        }

        writeIndex++;
      }
    }

    if (didCompact) {
      for (const name in this.propertyBuffers) {
        this.propertyBuffers[name].needsUpdate = true;
      }
    }

    this.instancedGeometry.instanceCount = writeIndex;
  }

  public sortByDistance(cameraWorldPosition: Vector3): void {
    const { instanceCount } = this.instancedGeometry;

    if (instanceCount < 2) {
      return;
    }

    const builtinBuffer = this.propertyBuffers.builtin as InstancedBufferAttribute | undefined;
    if (builtinBuffer === undefined) {
      return;
    }

    if (this.sortingIndices.length < instanceCount) {
      this.sortingIndices = new Int32Array(this.capacity);
      this.sortingSquaredDistances = new Float64Array(this.capacity);
    }

    const { array: builtinArray, itemSize: builtinItemSize } = builtinBuffer;

    for (let particleIndex = 0; particleIndex < instanceCount; particleIndex++) {
      this.sortingIndices[particleIndex] = particleIndex;
      const itemOffset = particleIndex * builtinItemSize;
      const dx = builtinArray[itemOffset + BUILTIN_OFFSET_POSITION_X] - cameraWorldPosition.x;
      const dy = builtinArray[itemOffset + BUILTIN_OFFSET_POSITION_Y] - cameraWorldPosition.y;
      const dz = builtinArray[itemOffset + BUILTIN_OFFSET_POSITION_Z] - cameraWorldPosition.z;
      this.sortingSquaredDistances[particleIndex] = dx * dx + dy * dy + dz * dz;
    }

    const sortingSquaredDistances = this.sortingSquaredDistances;
    const sortingIndices = this.sortingIndices.subarray(0, instanceCount);
    sortingIndices.sort(
      (indexA, indexB) => sortingSquaredDistances[indexB] - sortingSquaredDistances[indexA],
    );

    let maximumItemSize = 0;
    for (const name in this.propertyBuffers) {
      if (this.propertyBuffers[name].itemSize > maximumItemSize) {
        maximumItemSize = this.propertyBuffers[name].itemSize;
      }
    }

    const requiredTemporaryBufferSize = instanceCount * maximumItemSize;
    if (this.sortingTemporaryBuffer.length < requiredTemporaryBufferSize) {
      this.sortingTemporaryBuffer = new Float32Array(this.capacity * maximumItemSize);
    }

    for (const name in this.propertyBuffers) {
      const attribute = this.propertyBuffers[name];
      const { array, itemSize } = attribute;

      for (let newIndex = 0; newIndex < instanceCount; newIndex++) {
        const originalIndex = sortingIndices[newIndex];
        const sourceOffset = originalIndex * itemSize;
        const destinationOffset = newIndex * itemSize;

        for (let componentIndex = 0; componentIndex < itemSize; componentIndex++) {
          this.sortingTemporaryBuffer[destinationOffset + componentIndex] =
            array[sourceOffset + componentIndex];
        }
      }

      for (let i = 0; i < instanceCount * itemSize; i++) {
        array[i] = this.sortingTemporaryBuffer[i];
      }

      attribute.needsUpdate = true;
    }
  }

  public drop(): void {
    this.instancedGeometry.instanceCount = 0;
  }

  public destroy(): void {
    this.instancedGeometry.dispose();
    this.particleMaterial.dispose();
  }

  private ensureCapacity(requiredCapacity: number): void {
    if (requiredCapacity <= this.capacity) {
      return;
    }

    const newCapacity = Math.ceil(requiredCapacity / this.capacityStep) * this.capacityStep;

    for (const name in this.propertyBuffers) {
      const oldAttribute = this.propertyBuffers[name];
      const { itemSize, array, usage } = oldAttribute;
      const newArray = new Float32Array(newCapacity * itemSize);
      newArray.set(array);

      const newAttribute = new InstancedBufferAttribute(newArray, itemSize);
      newAttribute.setUsage(usage);
      this.instancedGeometry.setAttribute(`a_${name}`, newAttribute);
      this.propertyBuffers[name] = newAttribute;

      // Detach old typed array to help GC release GPU-side memory sooner.
      // Three.js does not expose dispose() on BufferAttribute directly,
      // but clearing the array reference prevents the old data from lingering.
      (oldAttribute.array as unknown) = null;
    }

    this.capacity = newCapacity;

    // Force the renderer to recalculate _maxInstanceCount on the next
    // setupVertexAttributes pass. The new InstancedBufferAttributes will
    // trigger a VAO rebind, at which point _maxInstanceCount is recomputed
    // from the current attribute sizes.
    //
    // _maxInstanceCount is an internal renderer cache field set by
    // WebGLBindingStates.js. It was never promoted to a public API in the
    // r157-r180 range. Deleting it is the standard workaround used across
    // the Three.js ecosystem (see #19706, #26363, #27205).
    //
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (this.instancedGeometry as any)._maxInstanceCount;
  }
}
