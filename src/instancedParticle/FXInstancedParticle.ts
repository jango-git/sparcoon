import type { BufferGeometry, Material, Matrix4, Vector3 } from "three";
import { InstancedBufferAttribute, InstancedBufferGeometry, Mesh, StreamDrawUsage } from "three";
import {
  FX_AGE,
  FX_CORE_LIFECYCLE,
  FX_CORE_POSITION,
  FX_LIFETIME,
  FX_POSITION_X,
  FX_POSITION_Y,
  FX_POSITION_Z,
} from "../coreLayout.js";
import type { GLTypeInfo } from "./glTypeInfo.js";

/**
 * @internal Instanced mesh backing one {@link FXEmitter}: a base primitive drawn once per particle,
 * plus packed per-particle state. Each field (core `position`/`lifecycle` and each user attribute)
 * is one `InstancedBufferAttribute` in {@link propertyBuffers}, exposed as `a_<name>`. All buffers
 * share one particle index and stay dense: births append, deaths compact survivors down, capacity
 * grows in `capacityStep` blocks - each just iterates every buffer in lockstep.
 */
export class FXInstancedParticle extends Mesh {
  public readonly propertyBuffers: Record<string, InstancedBufferAttribute> = {};

  private readonly instancedGeometry: InstancedBufferGeometry;
  private capacity: number;

  private bufferVersionInternal = 0;

  private sortingIndices: Int32Array = new Int32Array(0);
  private sortingSquaredDistances: Float64Array = new Float64Array(0);
  private sortingTemporaryBuffer: Float32Array = new Float32Array(0);

  constructor(
    varyings: Record<string, GLTypeInfo>,
    expectedCapacity: number,
    private readonly capacityStep: number,
    material: Material,
    baseGeometry: BufferGeometry,
  ) {
    const instancedGeometry = new InstancedBufferGeometry();

    // Copy the base geometry's position/uv/normal + index onto the instanced geometry so the
    // geometry-agnostic vertex epilogue transforms real mesh vertices. `baseGeometry` is caller-
    // owned (a primitive or a custom mesh asset, possibly shared across emitters) - never disposed
    // here.
    const baseIndex = baseGeometry.getIndex();
    if (baseIndex !== null) {
      instancedGeometry.setIndex(baseIndex);
    }
    instancedGeometry.setAttribute("position", baseGeometry.getAttribute("position"));
    instancedGeometry.setAttribute("uv", baseGeometry.getAttribute("uv"));
    instancedGeometry.setAttribute("normal", baseGeometry.getAttribute("normal"));

    super(instancedGeometry, material);

    this.frustumCulled = false;
    this.instancedGeometry = instancedGeometry;
    this.instancedGeometry.instanceCount = 0;

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

  // Bumped on every backing-array reallocation (capacity growth), so the emitter can cache its
  // per-tick name -> Float32Array record and rebuild only when this moves.
  public get bufferVersion(): number {
    return this.bufferVersionInternal;
  }

  public createInstances(count: number): void {
    const currentInstanceCount = this.instancedGeometry.instanceCount;
    this.ensureCapacity(currentInstanceCount + count);

    // Rows freed by `removeDeadParticles` (copy-down, no zeroing) still hold the previous occupant's
    // state - most dangerously a stale `age >= lifetime`, which no spawn graph can reset (the spawn
    // target has no `age` slot). Zero the claimed range so births start clean; flag each buffer so
    // the cleared rows reach the GPU even for buffers the spawn kernel does not itself write.
    const rangeBegin = currentInstanceCount;
    const rangeEnd = currentInstanceCount + count;
    for (const attribute of Object.values(this.propertyBuffers)) {
      const { array, itemSize } = attribute;
      array.fill(0, rangeBegin * itemSize, rangeEnd * itemSize);
      attribute.needsUpdate = true;
    }

    this.instancedGeometry.instanceCount += count;
  }

  public removeDeadParticles(): void {
    // Cull against core `lifecycle` (vec2 [age, lifetime]); alive while `age < lifetime`. Rides the
    // same copy-down as every other property buffer.
    const lifecycleBuffer = this.propertyBuffers[FX_CORE_LIFECYCLE] as
      InstancedBufferAttribute | undefined;
    if (lifecycleBuffer === undefined) {
      return;
    }

    const { array: lifecycleArray, itemSize: lifecycleItemSize } = lifecycleBuffer;
    const { instanceCount } = this.instancedGeometry;

    // Materialized once per call, not per survivor: a `for...in` inside the copy-down loop would
    // re-enumerate keys for every moved particle.
    const attributes = Object.values(this.propertyBuffers);

    let writeIndex = 0;
    let didCompact = false;

    for (let readIndex = 0; readIndex < instanceCount; readIndex++) {
      const offset = readIndex * lifecycleItemSize;

      if (lifecycleArray[offset + FX_AGE] < lifecycleArray[offset + FX_LIFETIME]) {
        if (writeIndex !== readIndex) {
          for (const attribute of attributes) {
            const { itemSize: dataItemSize, array: dataArray } = attribute;

            const sourceOffset = readIndex * dataItemSize;
            const destinationOffset = writeIndex * dataItemSize;

            dataArray.copyWithin(destinationOffset, sourceOffset, sourceOffset + dataItemSize);
          }

          didCompact = true;
        }

        writeIndex++;
      }
    }

    if (didCompact) {
      for (const attribute of attributes) {
        attribute.needsUpdate = true;
      }
    }

    this.instancedGeometry.instanceCount = writeIndex;
  }

  /**
   * Reorders every per-particle buffer back-to-front for correct alpha blending. Distances are
   * world-space (each center transformed by `meshWorldMatrix`), matching the shader's own
   * `p_cameraDistance` - correct under any transform, including non-uniform scale and shear.
   */
  public sortByDistance(cameraWorldPosition: Vector3, meshWorldMatrix: Matrix4): void {
    const { instanceCount } = this.instancedGeometry;

    if (instanceCount < 2) {
      return;
    }

    const positionBuffer = this.propertyBuffers[FX_CORE_POSITION] as
      InstancedBufferAttribute | undefined;
    if (positionBuffer === undefined) {
      return;
    }

    if (this.sortingIndices.length < instanceCount) {
      this.sortingIndices = new Int32Array(this.capacity);
      this.sortingSquaredDistances = new Float64Array(this.capacity);
    }

    const { array: positionArray, itemSize: positionItemSize } = positionBuffer;
    // Column-major elements, indexed directly to avoid a per-particle Vector3.
    const elements = meshWorldMatrix.elements;

    for (let particleIndex = 0; particleIndex < instanceCount; particleIndex++) {
      this.sortingIndices[particleIndex] = particleIndex;
      const itemOffset = particleIndex * positionItemSize;
      const positionX = positionArray[itemOffset + FX_POSITION_X];
      const positionY = positionArray[itemOffset + FX_POSITION_Y];
      const positionZ = positionArray[itemOffset + FX_POSITION_Z];
      // meshWorldMatrix * vec4(center, 1.0) - bottom row is (0,0,0,1), so no w divide.
      const deltaX =
        elements[0] * positionX +
        elements[4] * positionY +
        elements[8] * positionZ +
        elements[12] -
        cameraWorldPosition.x;
      const deltaY =
        elements[1] * positionX +
        elements[5] * positionY +
        elements[9] * positionZ +
        elements[13] -
        cameraWorldPosition.y;
      const deltaZ =
        elements[2] * positionX +
        elements[6] * positionY +
        elements[10] * positionZ +
        elements[14] -
        cameraWorldPosition.z;
      this.sortingSquaredDistances[particleIndex] =
        deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
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

  // Disposes the instanced geometry and the currently mounted material - not the constructor one,
  // which a live material hot-swap may have replaced and disposed.
  public destroy(): void {
    // position/uv/normal + index were borrowed by reference from the caller-owned base geometry
    // (constructor) - possibly shared with other live consumers of the same custom mesh asset.
    // Detach them first so dispose()'s GPU-buffer cascade only touches the `a_<name>` buffers this
    // instance actually owns, not a shared consumer's GPU cache.
    this.instancedGeometry.deleteAttribute("position");
    this.instancedGeometry.deleteAttribute("uv");
    this.instancedGeometry.deleteAttribute("normal");
    this.instancedGeometry.setIndex(null);
    this.instancedGeometry.dispose();
    (this.material as Material | undefined)?.dispose();
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

      // Dropping the CPU array does NOT free the GPU buffer: three's WebGLAttributes holds it in a
      // WeakMap keyed by the (now-replaced) BufferAttribute and only deletes it when that wrapper is
      // GC'd (no dispose() on BufferAttribute across r157-179). Best-effort, not deterministic.
      (oldAttribute.array as unknown) = undefined;
    }

    this.capacity = newCapacity;
    this.bufferVersionInternal++;
    this.invalidateInstanceCap();
  }

  // Force the renderer to recompute `_maxInstanceCount` on the next setupVertexAttributes pass. It
  // is an internal WebGLBindingStates cache, never promoted to public API across r157-r180; deleting
  // it is the standard ecosystem workaround (three #19706, #26363, #27205).
  private invalidateInstanceCap(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (this.instancedGeometry as any)._maxInstanceCount;
  }
}
