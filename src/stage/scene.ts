/*
Note that this glTF loader assumes a lot of things are always defined (textures, samplers, vertex/index info, etc.),
so you may run into issues loading files outside of the Sponza scene.

In particular, it is known to not work if there is a mesh with no material.
*/

import { registerLoaders, load } from '@loaders.gl/core';
import { GLTFLoader, GLTFWithBuffers, GLTFMesh, GLTFMeshPrimitive, GLTFMaterial, GLTFSampler } from '@loaders.gl/gltf';
import { ImageLoader } from '@loaders.gl/images';
import { Mat4, mat4 } from 'wgpu-matrix';
import { device, materialBindGroupLayout, modelBindGroupLayout } from '../renderer';
import { createModelUniformData, ModelGpuLayout, writeModelUniforms } from './gpu_layouts';

export function setupLoaders() {
    registerLoaders([GLTFLoader, ImageLoader]);
}

function getFloatArray(gltfWithBuffers: GLTFWithBuffers, attribute: number) {
    const gltf = gltfWithBuffers.json;
    const accessor = gltf.accessors![attribute];
    const bufferView = gltf.bufferViews![accessor.bufferView!];
    const buffer = gltfWithBuffers.buffers[bufferView.buffer];
    const byteOffset = (accessor.byteOffset ?? 0) + (bufferView.byteOffset ?? 0) + buffer.byteOffset;
    return new Float32Array(buffer.arrayBuffer, byteOffset, bufferView.byteLength / 4);
}

class Texture {
    // Retain the decoded source as well as the ordinary 2D GPU texture. The
    // normal render paths keep sampling `image`; Visibility Buffer later copies
    // `source` into a common texture-array layer for dynamic material lookup.
    source: ImageBitmap;
    image: GPUTexture;
    sampler: GPUSampler;

    constructor(source: ImageBitmap, image: GPUTexture, sampler: GPUSampler) {
        this.source = source;
        this.image = image;
        this.sampler = sampler;
    }
}

export class Material {
    private static nextId = 0;
    readonly id: number;

    // A Visibility Buffer shading invocation chooses a material from a single
    // texture_2d_array. This is the array layer assigned during scene loading,
    // not the glTF texture index (which may include normal/ORM textures).
    readonly visibilityTextureLayer: number;
    readonly diffuseTexture: Texture;

    materialBindGroup: GPUBindGroup;

    constructor(gltfMaterial: GLTFMaterial, textures: Texture[], visibilityTextureLayer: number) {
        this.id = Material.nextId++;
        this.visibilityTextureLayer = visibilityTextureLayer;

        const diffuseTexture = textures[gltfMaterial.pbrMetallicRoughness!.baseColorTexture!.index];
        this.diffuseTexture = diffuseTexture;

        this.materialBindGroup = device.createBindGroup({
            label: "material bind group",
            layout: materialBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: diffuseTexture.image.createView()
                },
                {
                    binding: 1,
                    resource: diffuseTexture.sampler
                }
            ]
        });
    }
}

export class Primitive {
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    numIndices = -1;

    // These CPU arrays mirror the original GPU draw buffers. They are kept so
    // the Visibility Buffer path can concatenate all primitives into a pair of
    // global read-only storage buffers after glTF loading. The existing paths
    // still use vertexBuffer/indexBuffer exactly as before.
    readonly vertexData: Float32Array<ArrayBuffer>;
    readonly indexData: Uint32Array<ArrayBuffer>;

    material: Material;

    constructor(gltfPrim: GLTFMeshPrimitive, gltfWithBuffers: GLTFWithBuffers, material: Material) {
        this.material = material;

        const gltf = gltfWithBuffers.json;

        const indicesAccessor = gltf.accessors![gltfPrim.indices!];
        const indicesBufferView = gltf.bufferViews![indicesAccessor.bufferView!];
        const indicesDataType = indicesAccessor.componentType;
        const indicesBuffer = gltfWithBuffers.buffers[indicesBufferView.buffer];
        const indicesByteOffset = (indicesAccessor.byteOffset ?? 0)
            + (indicesBufferView.byteOffset ?? 0)
            + indicesBuffer.byteOffset;
        let indicesArray: Uint32Array<ArrayBuffer>;
        // hardcoding webgl constants, very silly
        switch (indicesDataType) {
            case 0x1403: // UNSIGNED_SHORT
                indicesArray = Uint32Array.from(
                    new Uint16Array(indicesBuffer.arrayBuffer, indicesByteOffset, indicesAccessor.count));
                break;
            case 0x1405: // UNSIGNED_INT (untested)
                indicesArray = new Uint32Array(indicesBuffer.arrayBuffer, indicesByteOffset, indicesAccessor.count);
                break;
            default:
                throw new Error(`unsupported index buffer element component type: 0x${indicesDataType.toString(16)}`);
        }

        const positionsArray = getFloatArray(gltfWithBuffers, gltfPrim.attributes.POSITION);
        const normalsArray = getFloatArray(gltfWithBuffers, gltfPrim.attributes.NORMAL);
        const uvsArray = getFloatArray(gltfWithBuffers, gltfPrim.attributes.TEXCOORD_0);

        const numFloatsPerVert = 8;
        const numVerts = positionsArray.length / 3;
        const vertsArray = new Float32Array(numVerts * numFloatsPerVert);
        for (let vertIdx = 0; vertIdx < numVerts; ++vertIdx) {
            const vertStartIdx = vertIdx * numFloatsPerVert;
            vertsArray[vertStartIdx] = positionsArray[vertIdx * 3];
            vertsArray[vertStartIdx + 1] = positionsArray[vertIdx * 3 + 1];
            vertsArray[vertStartIdx + 2] = positionsArray[vertIdx * 3 + 2];
            vertsArray[vertStartIdx + 3] = normalsArray[vertIdx * 3];
            vertsArray[vertStartIdx + 4] = normalsArray[vertIdx * 3 + 1];
            vertsArray[vertStartIdx + 5] = normalsArray[vertIdx * 3 + 2];
            vertsArray[vertStartIdx + 6] = uvsArray[vertIdx * 2];
            vertsArray[vertStartIdx + 7] = uvsArray[vertIdx * 2 + 1];
        }

        this.indexData = indicesArray;
        this.vertexData = vertsArray;

        this.indexBuffer = device.createBuffer({
            label: "index buffer",
            size: indicesArray.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.indexBuffer, 0, this.indexData);

        this.vertexBuffer = device.createBuffer({
            label: "vertex buffer",
            size: vertsArray.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.vertexBuffer, 0, this.vertexData);

        this.numIndices = indicesArray.length;
    }
}

export class Mesh {
    primitives: Primitive[] = [];

    constructor(gltfMesh: GLTFMesh, gltfWithBuffers: GLTFWithBuffers, sceneMaterials: Material[]) {
        gltfMesh.primitives.forEach((gltfPrim: GLTFMeshPrimitive) => {
            this.primitives.push(new Primitive(gltfPrim, gltfWithBuffers, sceneMaterials[gltfPrim.material!]));
        });

        this.primitives.sort((primA: Primitive, primB: Primitive) => {
            return primA.material.id - primB.material.id;
        });
    }
}

export class Node {
    name: String = "node";

    parent: Node | undefined;
    children: Set<Node> = new Set<Node>();

    transform: Mat4 = mat4.identity();
    modelMatUniformBuffer!: GPUBuffer;
    modelBindGroup!: GPUBindGroup;
    mesh: Mesh | undefined;

    setName(newName: string) {
        this.name = newName;
    }

    setParent(newParent: Node) {
        if (this.parent != undefined) {
            this.parent.children.delete(this);
        }

        this.parent = newParent;
        newParent.children.add(this);
    }

    propagateTransformations() {
        if (this.parent != undefined) {
            this.transform = mat4.mul(this.parent.transform, this.transform);
        }

        if (this.mesh != undefined) {
            this.modelMatUniformBuffer = device.createBuffer({
                label: "model mat uniform",
                size: ModelGpuLayout.byteSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            // Positions use modelMat; normals use its inverse-transpose. This
            // matters for glTF nodes with non-uniform scale, where applying the
            // position matrix to a normal no longer preserves perpendicularity.
            const modelUniforms = createModelUniformData();
            const normalMat = mat4.transpose(mat4.inverse(this.transform));
            writeModelUniforms(modelUniforms, this.transform, normalMat);
            device.queue.writeBuffer(this.modelMatUniformBuffer, 0, modelUniforms);

            this.modelBindGroup = device.createBindGroup({
                label: "model bind group",
                layout: modelBindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: { buffer: this.modelMatUniformBuffer }
                    }
                ]
            });
        }

        for (let child of this.children) {
            child.propagateTransformations();
        }
    }
}

function createTexture(imageBitmap: ImageBitmap): GPUTexture {
    let texture = device.createTexture({
        size: [imageBitmap.width, imageBitmap.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });

    device.queue.copyExternalImageToTexture(
        { source: imageBitmap },
        { texture: texture },
        { width: imageBitmap.width, height: imageBitmap.height }
    );

    return texture;
}

function convertWrapModeEnum(wrapMode: number): GPUAddressMode {
    switch (wrapMode) {
        case 0x2901: // REPEAT
            return 'repeat';
        case 0x812F: // CLAMP_TO_EDGE
            return 'clamp-to-edge';
        case 0x8370: // MIRRORED_REPEAT
            return 'mirror-repeat';
        default:
            throw new Error(`unsupported wrap mode: 0x${wrapMode.toString(16)}`);
    }
}

function createSampler(gltfSampler: GLTFSampler): GPUSampler {
    let samplerDescriptor: GPUSamplerDescriptor = {};

    switch (gltfSampler.magFilter) {
        case 0x2600: // NEAREST
            samplerDescriptor.magFilter = 'nearest';
            break;
        case 0x2601: // LINEAR
            samplerDescriptor.magFilter = 'linear';
            break;
        default:
            throw new Error(`unsupported magFilter: 0x${gltfSampler.magFilter!.toString(16)}`);
    }

    switch (gltfSampler.minFilter) {
        case 0x2600: // NEAREST
            samplerDescriptor.minFilter = 'nearest';
            break;
        case 0x2601: // LINEAR
            samplerDescriptor.minFilter = 'linear';
            break;
        case 0x2700: // NEAREST_MIPMAP_NEAREST
            samplerDescriptor.minFilter = 'nearest';
            samplerDescriptor.mipmapFilter = 'nearest';
            break;
        case 0x2701: // LINEAR_MIPMAP_NEAREST
            samplerDescriptor.minFilter = 'linear';
            samplerDescriptor.mipmapFilter = 'nearest';
            break;
        case 0x2702: // NEAREST_MIPMAP_LINEAR
            samplerDescriptor.minFilter = 'nearest';
            samplerDescriptor.mipmapFilter = 'linear';
            break;
        case 0x2703: // LINEAR_MIPMAP_LINEAR
            samplerDescriptor.minFilter = 'linear';
            samplerDescriptor.mipmapFilter = 'linear';
            break;
        default:
            throw new Error(`unsupported minFilter: 0x${gltfSampler.minFilter!.toString(16)}`);
    }

    samplerDescriptor.addressModeU = convertWrapModeEnum(gltfSampler.wrapS!);
    samplerDescriptor.addressModeV = convertWrapModeEnum(gltfSampler.wrapT!);

    return device.createSampler(samplerDescriptor);
}

/**
 * One draw-visible instance. Object IDs identify Node x Primitive pairs rather
 * than meshes: the same mesh can appear under multiple nodes with different
 * model matrices, and the shading pass must be able to recover that transform.
 */
//Node
// └─ Mesh
//    └─ Primitive
export interface VisibilityRenderItem {
    //the ObjectID writen to visibility buffer
    objectId: number;
    //used for recovering model matrix/normal matrix in the shading pass
    node: Node;
    //used for recovering the primitive's properties in the shading pass
    primitive: Primitive;
}

/**
 * GPU resources shared by the Visibility Buffer geometry and compute passes.
 * The base and packed deferred renderers do not create or consume these.
 */
export interface VisibilitySceneData {
    //used in geometry pass
    renderItems: readonly VisibilityRenderItem[];
    //used in compute pass
    //all primitives' vertex data concatenated into a single storage buffer
    vertexStorageBuffer: GPUBuffer;
    //all primitives' index data concatenated into a single storage buffer
    indexStorageBuffer: GPUBuffer;
    //ObjectID -> Node x Primitive mapping, including model/normal matrices and geometry offsets
    //and material texture layer for shading.
    objectStorageBuffer: GPUBuffer;
    //material texture layer -> the layer
    materialTextureArrayView: GPUTextureView;
    //smapler strategy
    materialSampler: GPUSampler;
}
//temporary struct to hold the offsets of a primitive's geometry in the concatenated storage buffers
interface VisibilityGeometryOffsets {
    // Both offsets are element offsets used directly by WGSL, not byte offsets.
    // got by Object ID and Triangle ID
    vertexFloatOffset: number;
    indexOffset: number;
}

/**
 * Keep this host-side ABI next to the code that writes it. The matching WGSL
 * VisibilityObject is deliberately made self-describing: its counts let the
 * compute pass prove that a TriangleID belongs to this particular primitive,
 * rather than merely proving that it is somewhere inside the concatenated
 * global index buffer.
 * TypeScript 写入 objectStorageBuffer 的内存布局
 *             必须等于
 * WGSL VisibilityObject 读取时理解的内存布局
 *
 * Header: 8 u32 values (32 bytes)
 * Payload: modelMat + normalMat (2 x 64 bytes)
 * Total: 160 bytes, which is also a multiple of WGSL's 16-byte struct
 * alignment for matrices.
 */
const visibilityObjectHeaderUint32Count = 8;
const visibilityObjectFloatCount = 40;
const visibilityVertexFloatStride = 8;

// The visibility attachment reserves zero for cleared/background pixels. The
// remaining u32 packs a 16-bit object ID and a 16-bit triangle ID. Sponza's
// current largest primitive has 27,796 triangles, comfortably below this cap.
const visibilityTriangleIdBits = 16;
//[ObjectID(16 bits) | TriangleID(16 bits)]:65536 unique values
const visibilityIdLimit = 1 << visibilityTriangleIdBits;

// Every material's base-color texture is resampled to this common extent so a
// single texture_2d_array can be indexed in the compute shader. This matches
// the assignment's no-mipmapping allowance while keeping repeat UVs valid.
const visibilityMaterialAtlasExtent = 1024;

export class Scene {
    private root: Node = new Node();
    private visibilityMaterials: Material[] = [];
    //union type:similar to std::optional<VisibilitySceneData> in C++
    //this is for lazy initialization.Designned especially for the Visibility Buffer path
    private visibilitySceneData: VisibilitySceneData | undefined;

    constructor() {
        this.root.setName("root");
    }

    async loadGltf(filePath: string) {
        const gltfWithBuffers = await load(filePath) as GLTFWithBuffers;
        const gltf = gltfWithBuffers.json;

        let sceneTextures: Texture[] = [];
        {
            let sceneImages: GPUTexture[] = [];
            let sceneImageBitmaps: ImageBitmap[] = [];
            for (let gltfImage of gltfWithBuffers.images!) {
                const imageBitmap = gltfImage as ImageBitmap;
                sceneImageBitmaps.push(imageBitmap);
                sceneImages.push(createTexture(imageBitmap))
            }

            let sceneSamplers: GPUSampler[] = [];
            for (let gltfSampler of gltf.samplers!) {
                sceneSamplers.push(createSampler(gltfSampler));
            }

            for (let gltfTexture of gltf.textures!) {
                sceneTextures.push(new Texture(
                    sceneImageBitmaps[gltfTexture.source!],
                    sceneImages[gltfTexture.source!],
                    sceneSamplers[gltfTexture.sampler!],
                ));
            }
        }

        let sceneMaterials: Material[] = [];
        for (let gltfMaterial of gltf.materials!) {
            // Layer order follows material order, making MaterialID a stable
            // direct lookup into the Visibility Buffer texture array.
            sceneMaterials.push(new Material(gltfMaterial, sceneTextures, sceneMaterials.length));
        }
        this.visibilityMaterials = sceneMaterials;
        this.visibilitySceneData = undefined;

        let sceneMeshes: Mesh[] = [];
        for (let gltfMesh of gltf.meshes!) {
            sceneMeshes.push(new Mesh(gltfMesh, gltfWithBuffers, sceneMaterials));
        }

        let sceneRoot: Node = new Node();
        sceneRoot.setName("scene root");
        sceneRoot.setParent(this.root);

        let sceneNodes: Node[] = [];
        for (let gltfNode of gltf.nodes!) {
            let newNode = new Node();
            newNode.setName(gltfNode.name);
            newNode.setParent(sceneRoot);

            if (gltfNode.mesh != undefined) {
                newNode.mesh = sceneMeshes[gltfNode.mesh];
            }

            if (gltfNode.matrix != undefined) {
                newNode.transform = new Float32Array(gltfNode.matrix);
            } else {
                if (gltfNode.translation != undefined) {
                    newNode.transform = mat4.mul(newNode.transform, mat4.translation(gltfNode.translation));
                }

                if (gltfNode.rotation != undefined) {
                    newNode.transform = mat4.mul(newNode.transform, mat4.fromQuat(gltfNode.rotation));
                }

                if (gltfNode.scale != undefined) {
                    newNode.transform = mat4.mul(newNode.transform, mat4.scaling(gltfNode.scale));
                }
            }

            sceneNodes.push(newNode);
        }

        for (let nodeIdx in gltf.nodes!) {
            const gltfNode = gltf.nodes[nodeIdx];

            if (gltfNode.children == undefined) {
                continue;
            }

            for (let childNodeIdx of gltfNode.children) {
                sceneNodes[childNodeIdx].setParent(sceneNodes[nodeIdx]);
            }
        }

        sceneRoot.propagateTransformations();
    }

    /**
     * Lazily build the data representation needed only by Visibility Buffer.
     * This keeps the base/packed renderers unchanged and avoids allocating
     * duplicate storage buffers or a texture array unless the GUI mode is used.
     */
    getVisibilitySceneData(): VisibilitySceneData {
        if (this.visibilitySceneData !== undefined) {
            return this.visibilitySceneData;
        }
        if (this.visibilityMaterials.length === 0) {
            throw new Error("Visibility Buffer requires a loaded scene with materials.");
        }
        if (this.visibilityMaterials.length > device.limits.maxTextureArrayLayers) {
            throw new Error("Visibility material texture array exceeds maxTextureArrayLayers.");
        }

        const renderItems: VisibilityRenderItem[] = [];
        this.iterate(() => {}, () => {}, (primitive, node) => {
            const triangleCount = primitive.numIndices / 3;
            if (!Number.isInteger(triangleCount) || triangleCount >= visibilityIdLimit) {
                throw new Error(
                    `Primitive has ${triangleCount} triangles; Visibility Buffer supports fewer than ${visibilityIdLimit}.`,
                );
            }

            // The geometry pass and the storage buffers must describe exactly
            // the same triangle list. Fail during scene preparation if a
            // future asset violates the compact [pos|normal|uv] CPU layout or
            // contains an index that drawIndexed() itself would not reject.
            if (primitive.vertexData.length % visibilityVertexFloatStride !== 0) {
                throw new Error("Visibility Buffer vertex data is not an integral number of vertices.");
            }
            const vertexCount = primitive.vertexData.length / visibilityVertexFloatStride;
            for (const index of primitive.indexData) {
                if (index >= vertexCount) {
                    throw new Error("Visibility Buffer index data references a vertex outside its primitive.");
                }
            }
            renderItems.push({ objectId: renderItems.length, node, primitive });
        });

        // Reserve the all-ones packed ID as unreachable too, because adding one
        // converts the packed value into the non-zero attachment representation.
        if (renderItems.length >= visibilityIdLimit - 1) {
            throw new Error(`Scene has too many visibility objects for ${visibilityTriangleIdBits}-bit ObjectID packing.`);
        }

        // 解决：同一个 Primitive 被多个 Node 实例化时，顶点/index 被重复存多次
        // Geometry is concatenated once per unique Primitive. Object records
        // reference it with element offsets, so mesh instancing does not copy
        // vertex/index data merely because a node has a different transform.
        const geometryOffsets = new Map<Primitive, VisibilityGeometryOffsets>();
        let totalVertexFloatCount = 0;
        let totalIndexCount = 0;
        for (const renderItem of renderItems) {
            if (geometryOffsets.has(renderItem.primitive)) {
                continue;
            }
            geometryOffsets.set(renderItem.primitive, {
                vertexFloatOffset: totalVertexFloatCount,
                indexOffset: totalIndexCount,
            });
            totalVertexFloatCount += renderItem.primitive.vertexData.length;
            totalIndexCount += renderItem.primitive.indexData.length;
        }

        const visibilityVertexData = new Float32Array(totalVertexFloatCount);
        const visibilityIndexData = new Uint32Array(totalIndexCount);
        for (const [primitive, offsets] of geometryOffsets) {
            visibilityVertexData.set(primitive.vertexData, offsets.vertexFloatOffset);
            visibilityIndexData.set(primitive.indexData, offsets.indexOffset);
        }

        const validateStorageBufferSize = (byteSize: number, label: string) => {
            if (byteSize > device.limits.maxStorageBufferBindingSize) {
                throw new Error(`${label} exceeds maxStorageBufferBindingSize.`);
            }
        };
        validateStorageBufferSize(visibilityVertexData.byteLength, "Visibility vertex storage buffer");
        validateStorageBufferSize(visibilityIndexData.byteLength, "Visibility index storage buffer");

        const vertexStorageBuffer = device.createBuffer({
            label: "Visibility Buffer packed vertex storage",
            size: visibilityVertexData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        const indexStorageBuffer = device.createBuffer({
            label: "Visibility Buffer triangle index storage",
            size: visibilityIndexData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexStorageBuffer, 0, visibilityVertexData);
        device.queue.writeBuffer(indexStorageBuffer, 0, visibilityIndexData);

        // VisibilityObject's WGSL layout is an eight-u32 header followed by
        // two mat4x4f values: 32 + 64 + 64 = 160 bytes (40 f32 slots). The
        // header is written through Uint32Array; matrices through Float32Array
        // over the same ArrayBuffer. Keep these offsets synchronized with
        // visibility_lighting.cs.wgsl.
        const objectData = new ArrayBuffer(
            renderItems.length * visibilityObjectFloatCount * Float32Array.BYTES_PER_ELEMENT,
        );
        const objectUintView = new Uint32Array(objectData);
        const objectFloatView = new Float32Array(objectData);
        //upload to GPU buffer
        for (const renderItem of renderItems) {
            //distinguished one
            const offsets = geometryOffsets.get(renderItem.primitive)!;
            const base = renderItem.objectId * visibilityObjectFloatCount;
            objectUintView[base] = offsets.indexOffset;
            objectUintView[base + 1] = offsets.vertexFloatOffset;
            objectUintView[base + 2] = renderItem.primitive.indexData.length;
            objectUintView[base + 3] = renderItem.primitive.vertexData.length / visibilityVertexFloatStride;
            objectUintView[base + 4] = renderItem.primitive.material.visibilityTextureLayer;
            objectUintView[base + 5] = 0;
            objectUintView[base + 6] = 0;
            objectUintView[base + 7] = 0;

            objectFloatView.set(renderItem.node.transform, base + visibilityObjectHeaderUint32Count);
            const normalMat = mat4.transpose(mat4.inverse(renderItem.node.transform));
            objectFloatView.set(normalMat, base + visibilityObjectHeaderUint32Count + 16);
        }
        //every record records:
        // 几何在哪：indexOffset / vertexFloatOffset
        // 几何多大：indexCount / vertexCount
        // 材质是哪层：materialLayer
        // 实例怎么变换：modelMat / normalMat
        validateStorageBufferSize(objectData.byteLength, "Visibility object storage buffer");
        const objectStorageBuffer = device.createBuffer({
            label: "Visibility Buffer object records",
            size: objectData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(objectStorageBuffer, 0, objectData);

        // Compute shaders cannot choose among ordinary per-material bind groups.
        // Resampling source images into equal-sized array layers creates one
        // dynamically indexable texture_2d_array. The starter Sponza asset has
        // one sampler, so retaining the first material sampler preserves its
        // repeat/filter behavior while textureSampleLevel fixes LOD at zero.
        const materialTextureArray = device.createTexture({
            label: "Visibility Buffer base-color texture array",
            size: [
                visibilityMaterialAtlasExtent,
                visibilityMaterialAtlasExtent,
                this.visibilityMaterials.length,
            ],
            format: "rgba8unorm",
            // WebGPU requires COPY_DST + RENDER_ATTACHMENT on the destination of
            // copyExternalImageToTexture. Missing RENDER_ATTACHMENT makes every
            // upload a validation failure, so albedo samples stay black.
            usage:
                GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const resizeCanvas = new OffscreenCanvas(visibilityMaterialAtlasExtent, visibilityMaterialAtlasExtent);
        const resizeContext = resizeCanvas.getContext("2d");
        if (resizeContext === null) {
            throw new Error("Visibility Buffer could not create an OffscreenCanvas 2D context.");
        }
        for (const material of this.visibilityMaterials) {
            resizeContext.clearRect(0, 0, visibilityMaterialAtlasExtent, visibilityMaterialAtlasExtent);
            resizeContext.drawImage(
                material.diffuseTexture.source,
                0,
                0,
                visibilityMaterialAtlasExtent,
                visibilityMaterialAtlasExtent,
            );
            device.queue.copyExternalImageToTexture(
                //resized to visibilityMaterialAtlasExtent x visibilityMaterialAtlasExtent
                { source: resizeCanvas },
                {
                    texture: materialTextureArray,
                    origin: { x: 0, y: 0, z: material.visibilityTextureLayer },
                },
                [visibilityMaterialAtlasExtent, visibilityMaterialAtlasExtent, 1],
            );
        }

        this.visibilitySceneData = {
            renderItems,
            vertexStorageBuffer,
            indexStorageBuffer,
            objectStorageBuffer,
            materialTextureArrayView: materialTextureArray.createView({
                //corresponding to the texture_2d_array<f32> type in WGSL
                //var visibilityMaterialTextures: texture_2d_array<f32>;
                dimension: "2d-array",
                baseArrayLayer: 0,
                arrayLayerCount: this.visibilityMaterials.length,
            }),
            materialSampler: this.visibilityMaterials[0].diffuseTexture.sampler,
        };
        return this.visibilitySceneData;
    }

    iterate(nodeFunction: (node: Node) => void, materialFunction: (material: Material) => void,
        primFunction: (primitive: Primitive) => void) {
        let nodes = [this.root];

        let lastMaterialId: number | undefined = undefined;

        while (nodes.length > 0) {
            let node = nodes.pop() as Node;
            if (node.mesh != undefined) {
                nodeFunction(node);

                for (let primitive of node.mesh.primitives) {
                    if (primitive.material.id != lastMaterialId) {
                        materialFunction(primitive.material);
                        lastMaterialId = primitive.material.id;
                    }

                    primFunction(primitive);
                }
            }

            for (let childNode of node.children) {
                nodes.push(childNode);
            }
        }
    }
}
