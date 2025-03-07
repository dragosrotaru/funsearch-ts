import { Program } from "../code-manipulation/program.ts";
import { Function } from "../code-manipulation/function.ts";
import { Cluster } from "./cluster.ts";
import { Signature } from "./types.ts";
import * as math from "./math.ts";
import { ScoresPerTest } from "./types.ts";
import { renameFunctionCalls } from "../code-manipulation/parser.ts";

/**
 * "A sub-population of the programs database.
 */
export class Island {
  constructor(
    private template: Program,
    private nameOffunctionToEvolve: string,
    private functionsPerPrompt: number,
    private clusterSamplingTemperatureInit: number,
    private clusterSamplingTemperaturePeriod: number,
    private clusters: Map<Signature, Cluster> = new Map(),
    private numPrograms: number = 0
  ) {}

  getVersionedName(name: string, version: number): string {
    return `${name}_v${version}`;
  }

  /**
   * Represents test scores as a canonical signature.
   * @param scoresPerTest
   * @returns
   */
  getSignature(scoresPerTest: ScoresPerTest): Signature {
    const testValues = Object.values(scoresPerTest);
    return testValues.map((value) => Number(value));
  }

  get temperature(): number {
    const period = this.clusterSamplingTemperaturePeriod;
    return (
      this.clusterSamplingTemperatureInit *
      (1 - (this.numPrograms % period) / period)
    );
  }

  get scores(): number[] {
    return this.signatures.map(
      (signature) => this.clusters.get(signature)?.score || 0
    );
  }

  get signatures(): Signature[] {
    return Array.from(this.clusters.keys());
  }

  /**
   * Convert scores to probabilities using softmax with temperature schedule.
   */
  get probabilities(): number[] {
    return math.softmax(this.scores, this.temperature);
  }

  /**
   * Stores a program on this island, in its appropriate cluster.
   * @returns
   */
  registerProgram(program: Function, scoresPerTest: ScoresPerTest): void {
    const signature = this.getSignature(scoresPerTest);

    // todo Verify logic generated by GPT
    if (!this.clusters.has(signature)) {
      const score = math.reduceScore(scoresPerTest);
      this.clusters.set(signature, new Cluster(score, program));
    } else {
      this.clusters.get(signature)?.registerProgram(program);
    }
    this.numPrograms++;
  }

  /**
   * Constructs a prompt containing functions from this island.
   * @returns
   */
  getPrompt(): [string, number] {
    const { signatures, probabilities } = this;

    // At the beginning of an experiment when we have few clusters, place fewer
    // programs into the prompt.
    const functionsPerPrompt = Math.min(
      signatures.length,
      this.functionsPerPrompt
    );
    const indices = Array.from({ length: functionsPerPrompt }, () =>
      math.getRandomWeightedIndex(probabilities)
    );
    const chosenSignatures = indices.map((index) => signatures[index]);

    const implementations: Function[] = [];
    const scores: number[] = [];

    for (const signature of chosenSignatures) {
      const cluster = this.clusters.get(signature);
      if (cluster) {
        const program = cluster.sampleProgram();
        implementations.push(program);
        scores.push(cluster.score);
      }
    }

    const indicesSortedByScore = Array.from(
      { length: scores.length },
      (_, i) => i
    ).sort((a, b) => scores[a] - scores[b]);

    const sortedImplementations = indicesSortedByScore.map(
      (i) => implementations[i]
    );
    const versionGenerated = sortedImplementations.length + 1;

    return [this.generatePrompt(sortedImplementations), versionGenerated];
  }

  /**
   * Creates a prompt containing a sequence of function `implementations`.
   * @param implementations
   * @returns
   */
  generatePrompt(implementations: Function[]): string {
    const baseName = this.nameOffunctionToEvolve;
    // We will mutate these.

    // Format the names and docstrings of functions to be included in the prompt.
    const versionedFunctions: Function[] = [];

    implementations.forEach((impl, i) => {
      impl.name = this.getVersionedName(baseName, i);
      // Update the docstring for all subsequent functions after `_v0`.
      if (i > 0) {
        impl.docString = `Improved version of ${this.getVersionedName(
          baseName,
          i - 1
        )}.`;
      }
      // If the function is recursive, replace calls to itself with its new name.
      // TODO change
      impl = renameFunctionCalls(impl.toString(), baseName, impl.name);
      versionedFunctions.push(impl);
    });

    // Create the header of the function to be generated by the LLM.
    const header = implementations[implementations.length - 1];

    const nextVersion = implementations.length;
    header.name = this.getVersionedName(baseName, nextVersion);
    header.body = "";
    header.docString = `Improved version of ${this.getVersionedName(
      baseName,
      nextVersion - 1
    )}.`;
    versionedFunctions.push(header);

    // Replace functions in the template with the list constructed here.
    const newTemplate = this.template;
    newTemplate.functions = versionedFunctions;

    return newTemplate.toString();
  }
}
