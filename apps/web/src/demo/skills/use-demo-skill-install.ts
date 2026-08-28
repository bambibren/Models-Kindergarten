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

/** 执行「useDemoSkillInstall」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
export function useDemoSkillInstall(onCompleted?: (records: DemoSkillRecord[], batch: DemoSkillInstallBatch) => void) {
  const [batch, setBatch] = useState<DemoSkillInstallBatch | null>(null);
  const [error, setError] = useState("");
  const handledBatch = useRef<string | null>(null);
  const completedCallback = useRef(onCompleted);
  completedCallback.current = onCompleted;

  const start = useCallback(/** 缓存「start」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */
(sourceUrls: readonly string[]) => {
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

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (!batch || isDemoSkillInstallComplete(batch) || hasDemoSkillInstallFailed(batch)) return;
    const timer = window.setTimeout(/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */
() => setBatch(/** 执行「timer」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
(current) => current ? advanceDemoSkillInstallBatch(current) : current), 520);
    return /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */ () => window.clearTimeout(timer);
  }, [batch]);

  useEffect(/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */
() => {
    if (!batch || !isDemoSkillInstallComplete(batch) || handledBatch.current === batch.id) return;
    handledBatch.current = batch.id;
    const records = installedRecordsFromBatch(batch);
    saveDemoSkills(sessionStorage, records);
    completedCallback.current?.(records, batch);
  }, [batch]);

  return { batch, error, start, clear: /** 释放或删除「clear」对应资源，重复调用仍保持安全。 */
() => setBatch(null) };
}
