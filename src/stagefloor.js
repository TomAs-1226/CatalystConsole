/* The floor a stage stands a thing on: a pool of light, a grid that never shimmers, and a contact
 * shadow shaped like the thing's footprint.
 *
 * Park drew it first. The robot on its spec sheet, the Limelight in the Devices list and the Systemcore
 * on its own page all stand on the same one, so a part looks like it belongs to the same studio as the
 * robot it is bolted to.
 *
 * Uniforms: uFloor and uGrid (colours), uRadius (metres to the edge of the fade), uCell and uLine (grid
 * pitch and line width in metres; a line width of 0 draws no grid), uFootprint (half length and half
 * width of the contact shadow), uCorner (its corner radius) and uOpacity.
 */
export const FLOOR_VERTEX = /* glsl */ `
  varying vec2 vPlan;
  void main() {
    // The plane lies in its own xy before the mesh turns it flat, so xy here is the floor in metres:
    // x toward the robot's front, y toward its left.
    vPlan = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const FLOOR_FRAGMENT = /* glsl */ `
  uniform vec3 uFloor;
  uniform vec3 uGrid;
  uniform float uRadius;
  uniform float uCell;
  uniform float uLine;
  uniform vec2 uFootprint;
  uniform float uCorner;
  uniform float uOpacity;
  varying vec2 vPlan;

  // Grid lines with a constant world width that never alias. Where a line would be thinner than a
  // pixel it is drawn one pixel wide and dimmed to the same coverage, and where the cells themselves
  // shrink below a pixel the grid fades to its average brightness instead of shimmering. This is Ben
  // Golus's construction, and it is what keeps the far floor calm at a grazing camera angle.
  float gridLines(vec2 plan, float pitch, float width) {
    vec2 uv = plan / pitch;
    vec2 ddx = dFdx(uv);
    vec2 ddy = dFdy(uv);
    vec2 footprint = vec2(length(vec2(ddx.x, ddy.x)), length(vec2(ddx.y, ddy.y)));
    vec2 wanted = vec2(width / pitch);
    vec2 drawn = clamp(wanted, footprint, vec2(0.5));
    vec2 aa = footprint * 1.5;
    vec2 fromLine = 1.0 - abs(fract(uv) * 2.0 - 1.0);
    vec2 cover = smoothstep(drawn + aa, drawn - aa, fromLine);
    cover *= clamp(wanted / drawn, 0.0, 1.0);
    cover = mix(cover, wanted, clamp(footprint * 2.0 - 1.0, 0.0, 1.0));
    return mix(cover.x, 1.0, cover.y);
  }

  float roundedRect(vec2 p, vec2 halfSize, float corner) {
    vec2 q = abs(p) - halfSize + corner;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
  }

  void main() {
    float reach = clamp(length(vPlan) / uRadius, 0.0, 1.0);

    // The pool of light the robot stands in, falling away quickly and then lingering, the way a
    // spotlight's edge does.
    float light = pow(1.0 - reach, 3.5);
    vec3 colour = uFloor * light;

    // The lines are lit by the same pool as the floor, so they fade with it instead of glowing on
    // their own out in the dark, and they give out before the floor does, so they read as markings
    // around the robot rather than a lattice running off to the horizon.
    float grid = max(gridLines(vPlan, uCell, uLine) * 0.5, gridLines(vPlan, uCell * 4.0, uLine * 1.4));
    float gridLight = pow(1.0 - reach, 2.0) * (1.0 - smoothstep(0.05, 0.5, reach));
    colour = mix(colour, uGrid * gridLight, grid * 0.8);

    // The contact shadow: dense right under the bumpers, where no light reaches, and a wide soft
    // skirt around them. It darkens the grid lines too, which is most of what makes the robot sit on
    // the floor instead of hovering over it.
    float d = roundedRect(vPlan, uFootprint, uCorner);
    float shade = max((1.0 - smoothstep(-0.08, 0.06, d)) * 0.95, (1.0 - smoothstep(-0.12, 0.8, d)) * 0.7);
    colour *= 1.0 - shade;

    // uOpacity is the whole floor fading, when a flight hands the robot to a view with its own ground.
    gl_FragColor = vec4(colour, (1.0 - smoothstep(0.35, 0.9, reach)) * uOpacity);
    #include <colorspace_fragment>

    // A dark gradient this wide bands visibly in eight bits. A pixel of noise breaks the bands up and
    // costs nothing.
    float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    gl_FragColor.rgb += (grain - 0.5) / 255.0;
  }
`;
