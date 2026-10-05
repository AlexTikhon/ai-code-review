import "./args.test.js";
import "./classifier.test.js";
import "./ignore.test.js";
import "./patch.test.js";
import "./local-diff.test.js";
import "./privacy.test.js";
import "./findings.test.js";
import "./model.test.js";
import "./pipeline.test.js";
import "./retrieval.test.js";
import "./git-integration.test.js";
import "./github.test.js";
import "./prompt.test.js";
import "./cache.test.js";
import "./concurrency.test.js";
import "./pipeline-architecture.test.js";
import "./index-store.test.js";
import "./prepared-retrieval.test.js";
import "./semantic-index.test.js";
import "./semantic-retrieval.test.js";
import "./lexical-index.test.js";
import "./index-update.test.js";
import "./index-refresh.test.js";
import "./embedding-checkpoint.test.js";
import "./embedding-errors.test.js";
import "./embedding-execution.test.js";
import "./embedding-resilience.test.js";
import "./index-legacy.test.js";
import "./vector-format.test.js";
import "./vector-store.test.js";
import "./index-generation.test.js";
import "./index-migration.test.js";
import "./index-incremental-store.test.js";
import "./index-store-structure.test.js";
import "./anthropic-model.test.js";
import "./model-errors.test.js";
import "./failure-semantics.test.js";
import "./prompt-estimate.test.js";
import "./provider-composition.test.js";
import "./live-eval.test.js";
import { getTestCases } from "./helpers.js";

let completed = false;
// A test that awaits something nothing keeps alive would otherwise let Node
// exit 0 mid-run with no summary; treat an incomplete run as a failure.
process.on("exit", (code) => {
  if (!completed && code === 0) {
    console.error("FAIL test run ended before all tests completed");
    process.exitCode = 1;
  }
});

async function main() {
  const testCases = getTestCases();
  let failed = 0;

  for (const testCase of testCases) {
    try {
      await testCase.run();
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${testCase.name}`);
      console.error(error);
    }
  }

  completed = true;
  console.log(
    `\n${testCases.length - failed}/${testCases.length} tests passed`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
