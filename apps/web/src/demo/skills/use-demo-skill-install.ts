import { useCallback, useEffect, useRef, useState } from "react";
import {
  advanceDemoSkillInstallBatch,
  createDemoSkillInstallBatch,
  hasDemoSkillInstallFailed,
  installedRecordsFromBatch,
  isDemoSkillInstallComplete,
  listDemoSkills,
  saveDemoSkills,
  type DemoSkillInstallBatch,
  type DemoSkillRecord,
} from "./skill-install-state.js";

export function useDemoSkillInstall(onCompleted?: (records: DemoSkillRecord[], batch: DemoSkillInstallBatch) => void) {
  const [batch, setBatch] = useState<DemoSkillInstallBatch | null>(null);
  const [error, setError] = useState("");
  const handledBatch = useRef<string | null>(null);
  const completedCallback = useRef(onCompleted);
  completedCallback.current = onCompleted;

  const start = useCallback((sourceUrls: readonly string[]) => {
    try {
      const next = createDemoSkillInstallBatch(sourceUrls, listDemoSkills(sessionStorage));
      handledBatch.current = null;
      setError("");
      setBatch(next);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法开始安装");
      return false;
    }
  }, []);

  useEffect(() => {
    if (!batch || isDemoSkillInstallComplete(batch) || hasDemoSkillInstallFailed(batch)) return;
    const timer = window.setTimeout(() => setBatch((current) => current ? advanceDemoSkillInstallBatch(current) : current), 520);
    return () => window.clearTimeout(timer);
  }, [batch]);

  useEffect(() => {
    if (!batch || !isDemoSkillInstallComplete(batch) || handledBatch.current === batch.id) return;
    handledBatch.current = batch.id;
    const records = installedRecordsFromBatch(batch);
    saveDemoSkills(sessionStorage, records);
    completedCallback.current?.(records, batch);
  }, [batch]);

  return { batch, error, start, clear: () => setBatch(null) };
}
