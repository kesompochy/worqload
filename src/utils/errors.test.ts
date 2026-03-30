import { test, expect, spyOn } from "bun:test";
import { exitWithError } from "./errors";

test("exitWithError prints message to stderr and exits with code 1", () => {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => undefined as never);
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});

  exitWithError("something went wrong");

  expect(errorSpy).toHaveBeenCalledWith("something went wrong");
  expect(exitSpy).toHaveBeenCalledWith(1);

  exitSpy.mockRestore();
  errorSpy.mockRestore();
});
