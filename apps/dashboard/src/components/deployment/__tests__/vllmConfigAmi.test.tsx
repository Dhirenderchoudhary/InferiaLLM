import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { VllmConfig } from "../configSections";

function renderVllm(amiRequired: boolean) {
  const state = {
    selectedEngine: "vllm",
    dtype: "auto",
    quantization: "",
    maxModelLen: "",
    gpuUtil: "0.9",
    enforceEager: false,
    selectedAmiId: "",
    selectedHfTokenName: "",
    prefillReplicas: 1,
    decodeReplicas: 1,
    prefillGpuIndices: "",
    decodeGpuIndices: "",
    isDisaggOpen: false,
  };
  return render(
    <VllmConfig
      state={state as never}
      dispatch={vi.fn()}
      engineAmis={[]}
      amisLoading={false}
      amiRegion="us-east-1"
      amiRequired={amiRequired}
      hfTokenNames={[]}
    />
  );
}

// The label carries the required asterisk, so it is the thing that must not
// appear where no AMI is needed.
const amiLabel = () => document.querySelector('label[for="engineAmi"]');

describe("the engine AMI field follows requiresAmi", () => {
  it("is not shown for vLLM on a pool that needs no AMI, such as Kubernetes", () => {
    renderVllm(false);
    expect(amiLabel()).toBeNull();
    expect(screen.queryByText(/engine ami/i)).toBeNull();
  });

  it("is shown, marked required, for vLLM on an AWS pool", () => {
    renderVllm(true);
    expect(amiLabel()).not.toBeNull();
    expect(amiLabel()?.textContent).toContain("*");
  });
});
