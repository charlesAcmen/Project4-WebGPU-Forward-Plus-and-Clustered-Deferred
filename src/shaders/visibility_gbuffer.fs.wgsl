// Visibility Buffer geometry pass.
//
// Unlike the normal deferred G-buffer, this shader does not write position,
// normal, or albedo. Its one u32 output answers only: which object and which
// triangle produced this visible pixel? The compute pass reconstructs every
// shaded attribute later from storage buffers plus depth.

struct VisibilityDrawUniforms {
    // ObjectID identifies one Node x Primitive render item. The remaining
    // fields make this uniform 16 bytes, which is friendly to uniform layout
    // alignment and leaves room for future per-draw visibility parameters.
    objectId: u32,
    _padding0: u32,
    _padding1: u32,
    _padding2: u32,
}

// Binding 0 is the normal model matrix used by naive.vs.wgsl. Binding 1 is
// visibility-only, so the base/packed renderer bind groups remain untouched.
@group(${bindGroup_model}) @binding(1) var<uniform> visibilityDraw: VisibilityDrawUniforms;

// This sampling is intentionally retained in the geometry pass. Alpha-masked
// texels must discard before depth and visibility are written; otherwise the
// later shading pass would see opaque geometry where the base renderer has a
// hole. The compute pass samples the same base color again for visible pixels.
@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f,
}

@fragment
fn main(
    in: FragmentInput,
    // With triangle-list + one indexed draw per Primitive, primitiveIndex is
    // exactly the local TriangleID required to index three u32 values later.
    @builtin(primitive_index) primitiveIndex: u32,
) -> @location(0) u32 {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) {
        discard;
    }

    // Zero is cleared/background. Adding one makes every valid packed ID
    // non-zero; the compute pass subtracts it before unpacking the bit fields.
    let packedId = (visibilityDraw.objectId << ${visibilityTriangleIdBits}u) | primitiveIndex;
    return packedId + 1u;
}
