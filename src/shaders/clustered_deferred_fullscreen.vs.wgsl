// TODO-3: implement the Clustered Deferred fullscreen vertex shader

// This shader should be very simple as it does not need all of the information passed by the the naive vertex shader.
struct FullscreenVertexOutput {
    @builtin(position) position: vec4f,
}

@vertex
//vertex buffer-less
fn main(@builtin(vertex_index) vertexIndex: u32) -> FullscreenVertexOutput {
    // One oversized triangle covers the viewport without a vertex buffer.
    let positions = array<vec2f, 3>(
        //-1,-1: bottom-left corner for NDC
        // 1,1: top-right corner for NDC
        vec2f(-1.f, -1.f),
        //out side right side of the screen
        vec2f(3.f, -1.f),
        //out side top side of the screen
        vec2f(-1.f, 3.f),
        //this will cover the whole screen with a single triangle, and the fragment shader will be executed for each pixel in the viewport
    );

    var out: FullscreenVertexOutput;
    //z=0.f: nearest plane for this huge triangle
    //w=1.f: homogeneous coordinate normalized for the vertex position
    //X/W,Y/W: normalized device coordinates (NDC) for the vertex position
    out.position = vec4f(positions[vertexIndex], 0.f, 1.f);
    return out;
}
