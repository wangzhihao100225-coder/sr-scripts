// x_remove_promoted_combined_safe.js
// 适用于 Shadowrocket 的 http-response 脚本（safe 版本）
// 目的：优先精确清理 X timeline 的 promoted 条目，辅以保守递归字段清理
// 安全策略：尽量只删除明显的广告条目或字段；任何异常或没有变更时回退原始响应

function safeParse(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

function isClearlyPromoted(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // 明确的推广字段或广告标识
  if (obj.promoted_tweet_id || obj.promoted_tweet_ad_id || obj.is_promoted === true) return true;
  if (obj.promoted_metadata || obj.advertiser_info || obj.promoted) return true;
  // 某些条目的 id/name 会包含 promoted/advert 字样
  if (obj.entryId && typeof obj.entryId === 'string') {
    const id = obj.entryId.toLowerCase();
    if (id.includes('promoted') || id.includes('advert')) return true;
  }
  return false;
}

// 保守型：只删除明显被判定为广告的数组元素或对象字段
function cleanObjectConservative(root) {
  if (Array.isArray(root)) {
    const out = [];
    for (const el of root) {
      if (isClearlyPromoted(el)) continue;
      if (typeof el === 'object' && el !== null) {
        const cleaned = cleanObjectConservative(el);
        // 如果对象被完全判定为删除（null），跳过；否则保留
        if (cleaned !== null) out.push(cleaned);
      } else {
        out.push(el);
      }
    }
    return out;
  } else if (root && typeof root === 'object') {
    if (isClearlyPromoted(root)) return null; // 顶层对象若明确是 promoted，则删除
    const out = {};
    for (const k of Object.keys(root)) {
      try {
        const v = root[k];
        if (v === null) { out[k] = v; continue; }
        if (Array.isArray(v)) {
          out[k] = cleanObjectConservative(v);
        } else if (typeof v === 'object') {
          const cleaned = cleanObjectConservative(v);
          if (cleaned === null) {
            // 仅当该字段明确为 promoted 时删除字段，否则保留原值
            //（这里我们删除字段以避免残留广告对象）
            continue;
          } else out[k] = cleaned;
        } else {
          // 基本类型：如果字符串中明确带 promoted/advert 标记则跳过字段（保守）
          if (typeof v === 'string') {
            const vl = v.toLowerCase();
            if (vl.includes('promoted') || vl.includes('promot') || vl.includes('advert') || vl.includes('sponsor')) {
              continue;
            }
          }
          out[k] = v;
        }
      } catch (e) {
        // 出错则保守回退该字段原值
        out[k] = root[k];
      }
    }
    return out;
  }
  return root;
}

// 精确处理：处理 timeline instructions 中的 entries（你原脚本的思路）
function filterTimelineInstructions(instructions) {
  if (!Array.isArray(instructions)) return;
  for (const ins of instructions) {
    try {
      if (!ins || typeof ins !== 'object') continue;
      // 不同版本的 instruction 名称可能不同，优先匹配 TimelineAddEntries / timeline entries
      if (ins.type && typeof ins.type === 'string' && ins.entries && Array.isArray(ins.entries)) {
        ins.entries = ins.entries.filter(entry => {
          // 检查 entryId 与 entry.content.itemContent.promoted_metadata 等
          let promoted = false;
          try {
            const entryId = entry.entryId || '';
            if (typeof entryId === 'string' && (entryId.toLowerCase().includes('promoted') || entryId.toLowerCase().includes('advert'))) promoted = true;
          } catch (e) {}
          try {
            const pm = entry.content?.itemContent?.promoted_metadata || entry.content?.itemContent?.promoted;
            if (pm) promoted = true;
          } catch (e) {}
          // 如果条目被明确标记为 promoted 或包含广告元数据，则过滤掉
          if (promoted) return false;
          // 否则保留
          return true;
        });
      }
    } catch (e) {
      // 忽略单个 instruction 的错误，继续处理其他 instruction
      continue;
    }
  }
}

try {
  if (!$response || !$response.body) {
    $done({body: $response ? $response.body : ''});
  } else {
    const originalBody = $response.body;
    const json = safeParse(originalBody);
    if (!json) {
      // 非 JSON，直接返回原始响应
      $done({body: originalBody});
    } else {
      // 1) 优先尝试精确路径（home / search / user timeline 等）
      try {
        if (json.data?.home?.home_timeline_urt?.instructions) {
          filterTimelineInstructions(json.data.home.home_timeline_urt.instructions);
        } else if (json.data?.search_by_raw_query?.search_timeline?.timeline?.instructions) {
          filterTimelineInstructions(json.data.search_by_raw_query.search_timeline.timeline.instructions);
        } else if (json.data?.timeline?.instructions) {
          // 兼容不同命名的 timeline
          filterTimelineInstructions(json.data.timeline.instructions);
        }
      } catch (e) {
        // 忽略路径错误，继续后续保守清理
      }

      // 2) 保守递归清理：只删除明显广告对象或字段
      const cleaned = cleanObjectConservative(json);

      // 3) 若 cleaned 与原始相同（没有变更），直接返回原始，避免触发不必要的差异
      const outStr = JSON.stringify(cleaned);
      if (!outStr || outStr.length === 0 || outStr === originalBody) {
        $done({body: originalBody});
      } else {
        $done({body: outStr});
      }
    }
  }
} catch (err) {
  // 出错时回退为原始响应，保证稳定性
  $done({body: $response && $response.body ? $response.body : ''});
}
