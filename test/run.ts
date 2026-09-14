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
import { getTestCases } from "./helpers.js";

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
