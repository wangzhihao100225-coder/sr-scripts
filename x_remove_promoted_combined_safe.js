// 优化的 X (Twitter) 去广告脚本 - 高效精准版
// 移除了危险的全局字符串匹配和高耗时的全局递归

function safeParse(body) {
  try { return JSON.parse(body); } catch (e) { return null; }
}

// 仅针对 Timeline 的 entries 数组进行精确过滤
function filterTimelineInstructions(instructions) {
  if (!Array.isArray(instructions)) return false;
  let modified = false;

  for (const ins of instructions) {
    if (!ins || typeof ins !== 'object') continue;
    
    // 匹配 TimelineAddEntries 类型的指令
    if ((ins.type === 'TimelineAddEntries' || ins.type === 'TimelineReplaceEntry') && Array.isArray(ins.entries)) {
      const originalLength = ins.entries.length;
      
      ins.entries = ins.entries.filter(entry => {
        let isAd = false;
        
        // 1. 检查 entryId 是否包含广告标识
        const entryId = entry.entryId || '';
        if (typeof entryId === 'string') {
          const idLower = entryId.toLowerCase();
          if (idLower.includes('promoted') || idLower.includes('advert')) {
            isAd = true;
          }
        }
        
        // 2. 检查内部内容是否带有广告元数据 (精确匹配字段名，绝不误杀正文)
        try {
          const itemContent = entry.content?.itemContent || entry.item?.itemContent;
          if (itemContent && (itemContent.promotedMetadata || itemContent.promoted_metadata || itemContent.promoted)) {
            isAd = true;
          }
        } catch (e) {}

        return !isAd; // 是广告则过滤掉 (返回 false)
      });

      if (ins.entries.length !== originalLength) {
        modified = true;
      }
    }
  }
  return modified;
}

try {
  if (!$response || !$response.body) {
    $done({});
  } else {
    const originalBody = $response.body;
    const json = safeParse(originalBody);
    
    if (!json) {
      $done({body: originalBody}); // 非 JSON，直接放行
    } else {
      let isModified = false;

      // 精确拦截 X 的主要 Timeline 路径
      if (json.data?.home?.home_timeline_urt?.instructions) {
        isModified = filterTimelineInstructions(json.data.home.home_timeline_urt.instructions);
      } else if (json.data?.search_by_raw_query?.search_timeline?.timeline?.instructions) {
        isModified = filterTimelineInstructions(json.data.search_by_raw_query.search_timeline.timeline.instructions);
      } else if (json.data?.user?.result?.timeline_v2?.timeline?.instructions) {
        isModified = filterTimelineInstructions(json.data.user.result.timeline_v2.timeline.instructions);
      }

      // 如果有修改，则返回新的 JSON 字符串；否则返回原数据节约开销
      if (isModified) {
        $done({body: JSON.stringify(json)});
      } else {
        $done({body: originalBody});
      }
    }
  }
} catch (err) {
  // 发生任何异常，安全放行原始数据
  console.log(`X 去广告脚本执行异常: ${err}`);
  $done({body: $response.body || ''});
}
