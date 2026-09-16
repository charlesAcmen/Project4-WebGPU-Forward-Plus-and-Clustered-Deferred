import { Camera } from "./camera";
import { Clusters } from "./clusters";
import { Lights } from "./lights";
import { Scene } from "./scene";

export class Stage {
    scene: Scene;
    lights: Lights;
    camera: Camera;
    clusters: Clusters;
    stats: Stats;

    constructor(scene: Scene, lights: Lights, camera: Camera, clusters: Clusters, stats: Stats) {
        this.scene = scene;
        this.lights = lights;
        this.camera = camera;
        this.clusters = clusters;
        this.stats = stats;
    }
}
