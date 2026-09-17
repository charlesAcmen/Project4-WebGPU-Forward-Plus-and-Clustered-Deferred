// TODO-3: implement the Clustered Deferred G-buffer fragment shader

// This shader should only store G-buffer information and should not do any shading.
@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f,
}

struct GBufferOutput {
    // A zero alpha marks a cleared/background pixel for the fullscreen pass.
    @location(0) position: vec4f,
    @location(1) albedo: vec4f,
    @location(2) normal: vec4f,
}

@fragment
fn main(in: FragmentInput) -> GBufferOutput {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    //0.5f:alphacutoff for gltf 2.0 in mask mode
    if (diffuseColor.a < 0.5f) {
        //WGSL/GLSL:the fragment will be discarded
        //so the Z-buffer will not be updated and the pixel will be considered as background
        discard;
    }

    var out: GBufferOutput;
    //GBufferOutput has alpha channel
    //1.f marks a valid pixel for the fullscreen pass
    //if (gAlbedo.a == 0.0) {
    //   return vec4f(0.0, 0.0, 0.0, 1.0);
    // }
    // this will save another field called mask in GBufferOutput
    out.position = vec4f(in.pos, 1.f);
    out.albedo = vec4f(diffuseColor.rgb, 1.f);
    out.normal = vec4f(normalize(in.nor), 1.f);
    return out;
}
