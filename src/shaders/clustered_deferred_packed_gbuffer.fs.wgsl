// Extra Credit G-buffer producer. The original three-target implementation is
// intentionally retained in clustered_deferred.fs.wgsl for side-by-side study.

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput {
    @location(0) pos: vec3f,
    // naive.vs.wgsl now guarantees this is a world-space normal.
    @location(1) nor: vec3f,
    @location(2) uv: vec2f,
}

struct PackedGBufferOutput {
    // rgba8uint stores exactly four bytes rather than the base path's 20-byte
    // color G-buffer payload:
    //
    //   R = octahedral normal X, 8 bits
    //   G = octahedral normal Y, 8 bits
    //   B = RGB565 low byte
    //   A = RGB565 high byte
    //
    // The geometry pass therefore stores 16 bits of normal plus 16 bits of
    // albedo. It deliberately omits world position; the compute consumer
    // reconstructs it from depth and inverseViewProjMat instead of fetching a
    // separate position texture. This is a bandwidth trade: a little extra
    // arithmetic replaces substantially more per-pixel VRAM traffic.
    @location(0) packedMaterial: vec4u,
}

fn signNotZero(value: f32) -> f32 {
    return select(-1.f, 1.f, value >= 0.f);
}

// Octahedral encoding represents a unit vector using two signed components.
// It has much lower angular error than simply dropping world-space Z.
fn encodeOctNormal(normal: vec3f) -> vec2f {
    let l1Normalized = normal / (abs(normal.x) + abs(normal.y) + abs(normal.z));
    var oct = l1Normalized.xy;
    if (l1Normalized.z < 0.f) {
        oct = (vec2f(1.f) - abs(oct.yx)) * vec2f(signNotZero(oct.x), signNotZero(oct.y));
    }
    return oct * 0.5f + 0.5f;
}

// RGB565 uses 5/6/5 bits. It is deliberately explicit instead of depending on
// normalized render-target conversion, so the compute pass recovers the exact
// bytes with textureLoad from rgba8uint.
fn encodeRgb565(color: vec3f) -> u32 {
    let clamped = clamp(color, vec3f(0.f), vec3f(1.f));
    let red = u32(round(clamped.r * 31.f));
    let green = u32(round(clamped.g * 63.f));
    let blue = u32(round(clamped.b * 31.f));
    return red | (green << 5u) | (blue << 11u);
}

@fragment
fn main(in: FragmentInput) -> PackedGBufferOutput {
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    // Preserve the base renderer's alpha-mask behavior, including its depth
    // rejection, before emitting any packed G-buffer data.
    if (diffuseColor.a < 0.5f) {
        discard;
    }

    let octNormal = encodeOctNormal(normalize(in.nor));
    let normalX = u32(round(octNormal.x * 255.f));
    let normalY = u32(round(octNormal.y * 255.f));
    let rgb565 = encodeRgb565(diffuseColor.rgb);

    var out: PackedGBufferOutput;
    out.packedMaterial = vec4u(normalX, normalY, rgb565 & 0xffu, rgb565 >> 8u);
    return out;
}
