// CHECKITOUT: you can use this vertex shader for all of the renderers

// TODO-1.3: add a uniform variable here for camera uniforms (of type CameraUniforms)
// make sure to use ${bindGroup_scene} for the group
// This declaration must match the host bind-group layout: group 0, binding 0, uniform buffer.
@group(${bindGroup_scene}) @binding(0) var<uniform> cameraUniforms: CameraUniforms;

@group(${bindGroup_model}) @binding(0) var<uniform> modelMat: mat4x4f;

struct VertexInput
{
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

struct VertexOutput
{
    @builtin(position) fragPos: vec4f,
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

@vertex
fn main(in: VertexInput) -> VertexOutput
{
    let modelPos = modelMat * vec4(in.pos, 1);

    var out: VertexOutput;
    // World-space modelPos becomes clip space for rasterization through the camera transform.
    out.fragPos = cameraUniforms.viewProjMat * modelPos; // TODO-1.3:CameraUniforms uniform variable
    out.pos = modelPos.xyz / modelPos.w;
    out.nor = in.nor;
    out.uv = in.uv;
    return out;
}
