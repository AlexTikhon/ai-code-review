type TestCase = {
  name: string;
  run: () => void | Promise<void>;
};

const testCases: TestCase[] = [];

export function unitTest(name: string, run: () => void | Promise<void>): void {
  testCases.push({ name, run });
}

export function getTestCases(): TestCase[] {
  return testCases;
}
