import { describe, expect, it } from "vitest";
import type { DemoModelStudent } from "../demo-types.js";
import {
  buildDemoModelStudent,
  createAdmissionDraft,
  demoModelStudentStorageKey,
  demoSelectedModelStudentStorageKey,
  loadSavedModelStudents,
  mergeModelStudents,
  saveModelStudent,
  simulateAdmissionTest,
  switchAdmissionProvider,
  updateAdmissionDraft,
  validateAdmissionDraft,
} from "./model-admission-state.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    dump: () => JSON.stringify(Object.fromEntries(values)),
  };
}

function successfulStudent(id = "student-test"): { student: DemoModelStudent; apiKey: string } {
  const apiKey = "sk-demo-super-secret-1234";
  const draft = updateAdmissionDraft(createAdmissionDraft("siliconflow"), { apiKey, name: "硅基流动新生" });
  const result = simulateAdmissionTest(draft);
  if (!result.ok || !result.models[0]) throw new Error("测试 fixture 无法发现模型");
  return { student: buildDemoModelStudent(draft, result.models[0], id), apiKey };
}

describe("model admission state", () => {
  it("creates protocol-specific drafts and clears all connection fields when switching provider", () => {
    const ollama = createAdmissionDraft();
    expect(ollama).toMatchObject({ providerId: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "" });

    const dirty = updateAdmissionDraft(ollama, { name: "旧名称", apiKey: "secret", modelId: "old-model" });
    const siliconflow = switchAdmissionProvider(dirty, "siliconflow");
    expect(siliconflow).toEqual({
      providerId: "siliconflow",
      connectionName: "",
      name: "",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "",
      modelId: "",
    });
    expect(switchAdmissionProvider(siliconflow, "siliconflow")).toBe(siliconflow);
  });

  it("validates only the fields needed to test each provider connection", () => {
    expect(validateAdmissionDraft(createAdmissionDraft("ollama")).valid).toBe(true);
    expect(validateAdmissionDraft(createAdmissionDraft("siliconflow"))).toMatchObject({
      valid: false,
      errors: { apiKey: "请粘贴有效的 API Key。" },
    });

    const responses = updateAdmissionDraft(createAdmissionDraft("custom_responses"), {
      baseUrl: "http://responses.example.test/v1",
      apiKey: "sk-demo-12345678",
    });
    expect(validateAdmissionDraft(responses).errors).toMatchObject({
      connectionName: "请为这条自定义连接命名。",
      baseUrl: "自定义云端接口必须使用 HTTPS。",
      modelId: "请输入上游模型 ID。",
    });
  });

  it("discovers only Ollama, SiliconFlow, and custom Responses demo models with capabilities", () => {
    const ollama = simulateAdmissionTest(createAdmissionDraft("ollama"));
    expect(ollama.ok && ollama.models.map((model) => model.id)).toEqual(["qwen3:8b", "deepseek-r1:8b"]);

    const siliconflow = simulateAdmissionTest(updateAdmissionDraft(createAdmissionDraft("siliconflow"), { apiKey: "sk-demo-12345678" }));
    expect(siliconflow.ok && siliconflow.models[0]).toMatchObject({
      id: "Qwen/Qwen3-8B",
      capabilities: { streaming: "supported", toolCalls: "supported", reasoning: "supported", usage: "supported" },
    });

    const responses = simulateAdmissionTest(updateAdmissionDraft(createAdmissionDraft("custom_responses"), {
      connectionName: "我的 Responses",
      baseUrl: "https://responses.example.test/v1",
      apiKey: "sk-demo-12345678",
      modelId: "gpt-5.5",
    }));
    expect(responses).toMatchObject({ ok: true, models: [{ id: "gpt-5.5" }] });
  });

  it("returns deterministic provider-specific failures for the Demo invalid convention", () => {
    const ollama = updateAdmissionDraft(createAdmissionDraft("ollama"), { baseUrl: "http://invalid.local:11434" });
    expect(simulateAdmissionTest(ollama)).toEqual({ ok: false, error: "没有检测到 Ollama，请确认本地服务已经启动。" });

    const siliconflow = updateAdmissionDraft(createAdmissionDraft("siliconflow"), { apiKey: "sk-invalid-demo" });
    expect(simulateAdmissionTest(siliconflow)).toEqual({ ok: false, error: "硅基流动拒绝了当前 API Key，请检查后重试。" });

    const responses = updateAdmissionDraft(createAdmissionDraft("custom_responses"), {
      connectionName: "失效连接",
      baseUrl: "https://invalid.example/v1",
      apiKey: "sk-demo-12345678",
      modelId: "gpt-5.5",
    });
    expect(simulateAdmissionTest(responses)).toEqual({ ok: false, error: "Responses 接口不可用，或当前地址与协议不兼容。" });
  });

  it("builds a pending ModelStudent without carrying the raw API Key", () => {
    const { student, apiKey } = successfulStudent();
    expect(student).toMatchObject({
      id: "student-test",
      name: "硅基流动新生",
      model: "Qwen/Qwen3-8B",
      provider: "硅基流动",
      protocol: "openai_chat_completions",
      baseUrl: "https://api.siliconflow.cn/v1",
      credentialHint: "•••• 1234",
      score: null,
      state: "待评测",
    });
    expect(JSON.stringify(student)).not.toContain(apiKey);
  });

  it("persists a sanitized upsert, selects it, and never stores the raw API Key", () => {
    const storage = memoryStorage();
    const { student, apiKey } = successfulStudent();
    saveModelStudent(storage, student);
    saveModelStudent(storage, { ...student, name: "改名后的新生" });

    expect(loadSavedModelStudents(storage)).toHaveLength(1);
    expect(loadSavedModelStudents(storage)[0]?.name).toBe("改名后的新生");
    expect(storage.getItem(demoSelectedModelStudentStorageKey)).toBe(student.id);
    expect(storage.getItem(demoModelStudentStorageKey)).not.toContain(apiKey);
    expect(storage.dump()).not.toContain(apiKey);
  });

  it("ignores malformed or unsafe stored records", () => {
    const storage = memoryStorage();
    storage.setItem(demoModelStudentStorageKey, "not-json");
    expect(loadSavedModelStudents(storage)).toEqual([]);

    storage.setItem(demoModelStudentStorageKey, JSON.stringify([{ id: "unsafe", apiKey: "raw-secret" }]));
    expect(loadSavedModelStudents(storage)).toEqual([]);
  });

  it("merges saved students ahead of built-ins and replaces matching IDs", () => {
    const saved = successfulStudent("same-id").student;
    const builtIn = { ...saved, name: "内置名称" };
    const other = { ...saved, id: "other-id", name: "另一个内置模型" };
    expect(mergeModelStudents([saved], [builtIn, other]).map((student) => student.name)).toEqual([
      "硅基流动新生",
      "另一个内置模型",
    ]);
  });
});
