(function() {
  'use strict';

  // 安全检查
  if (typeof $response === 'undefined' || !$response.body) {
    $done({});
    return;
  }

  const safeParse = (body) => {
    try { return JSON.parse(body); } catch (e) { return null; }
  };

  // 广告判定逻辑
  function isAd(entry) {
    if (!entry) return false;
    const entryType = entry.content?.entryType || entry.__typename || "";
    const itemContent = entry.content?.itemContent || entry.item?.itemContent || {};
    const socialContext = itemContent.socialContext || {};
    
    const hasPromoted = !!(
      itemContent.promotedMetadata ||
      itemContent.promoted_metadata ||
      itemContent.promoted ||
      itemContent.advertiser_info ||
      socialContext.contextType === "Promoted"
    );

    return (
      /promoted|advert|sponsor/i.test(entry.entryId || "") ||
      hasPromoted
    ) && entryType !== "TimelineCursor" && !/TimelineModule/.test(entryType);
  }

  // 必需节点判定（安全优先）
  function isEssential(entry) {
    const entryId = entry.entryId || "";
    const entryType = entry.content?.entryType || entry.__typename || "";
    const itemContent = entry.content?.itemContent || entry.item?.itemContent || {};
    
    // 保护详情页主焦点推文
    if (itemContent.tweetDisplayType === "TweetDetail") {
      return true;
    }

    return /cursor|conversation|thread|reply|timeline-response|module|who-to-follow|pin/i.test(entryId) ||
           /TimelineCursor|TimelineModule|TimelineTimelineModule|TimelinePinEntry/i.test(entryType);
  }

  // 处理entries：in-place修改，【修复1】新增 isSub 参数
  function processEntries(entries, isSub = false) {
    if (!Array.isArray(entries)) return false;
    const originalLength = entries.length;
    let modified = false;
    // let removedCount = 0; // 可选：计数移除
    const newEntries = [];

    for (let entry of entries) {
      let keep = true;
      let itemsEmptied = false;

      // 递归处理子 items
      if (entry.content?.items && Array.isArray(entry.content.items)) {
        const preLen = entry.content.items.length;
        // 子递归时 isSub = true
        if (processEntries(entry.content.items, true)) modified = true;
        
        if (preLen > 0 && entry.content.items.length === 0) {
          itemsEmptied = true;
        }
      }

      // 【修复3】安全优先：先判断 isEssential，即使 itemsEmptied 也保留空壳
      if (isEssential(entry)) {
        keep = true;
      } else if (itemsEmptied) {
        keep = false; // 仅对非 essential 应用丢弃空模块
        modified = true;
        // removedCount++;
      } else if (isAd(entry)) {
        keep = false;
        modified = true;
        // removedCount++;
      }

      if (keep) newEntries.push(entry);
    }

    // 【修复1 & 修复2】仅对 top-level (非 isSub) 启用空保护，且激活时返回 false
    if (!isSub && newEntries.length === 0 && originalLength > 0) {
      console.log(`[X净化] 警告: 过滤后 entries 为空，保留原数组以防空 timeline`);
      return false; 
    }

    // in-place替换（移除冗余长度检查，依赖现有modified）
    entries.length = 0;
    entries.push(...newEntries);
    return modified;
  }

  // 处理instructions：in-place修改
  function processInstructions(instructions) {
    if (!Array.isArray(instructions)) return false;
    const originalLength = instructions.length;
    let modified = false;
    const newIns = [];

    for (let ins of instructions) {
      let keep = true;

      if (ins.entries && Array.isArray(ins.entries)) {
        // 第一层 entries 通常是 top-level，所以 isSub 默认为 false
        if (processEntries(ins.entries, false)) modified = true;
      }

      if (ins.entry) {
        let itemsEmptied = false;
        if (ins.entry.content?.items && Array.isArray(ins.entry.content.items)) {
          const preLen = ins.entry.content.items.length;
          // ins.entry.content.items 属于子层级，isSub = true
          if (processEntries(ins.entry.content.items, true)) modified = true;
          if (preLen > 0 && ins.entry.content.items.length === 0) {
            itemsEmptied = true;
          }
        }

        // 同步应用修复3的逻辑排序
        if (isEssential(ins.entry)) {
          keep = true;
        } else if (itemsEmptied) {
          keep = false;
          modified = true;
        } else if (isAd(ins.entry)) {
          keep = false;
          modified = true;
        }
      }

      // 递归处理其他嵌套
      if (ins.timeline?.instructions && Array.isArray(ins.timeline.instructions)) {
        if (processInstructions(ins.timeline.instructions)) modified = true;
      } else if (ins.instructions && Array.isArray(ins.instructions)) {
        if (processInstructions(ins.instructions)) modified = true;
      }

      if (keep) newIns.push(ins);
    }

    // 【修复2】指令层级的空保护，触发时返回 false
    if (newIns.length === 0 && originalLength > 0) {
      console.log(`[X净化] 警告: 过滤后 instructions 为空，保留原数组以防崩溃`);
      return false;
    }

    // in-place（移除冗余长度检查）
    instructions.length = 0;
    instructions.push(...newIns);
    return modified;
  }

  // 主流程
  try {
    const rawBody = $response.body;
    const json = safeParse(rawBody);

    if (!json) {
      console.log(`[X净化] 无法解析JSON。体积: ${(rawBody.length / 1024).toFixed(2)} KB`);
      $done({ body: rawBody });
      return;
    }

    let changed = false;
    const data = json.data || json || {};
    
    // 需要过滤的 JSON 路径
    const paths = [
      data.home?.home_timeline_urt?.instructions,
      data.threaded_conversation_with_injections_v2?.instructions,
      data.search_by_raw_query?.search_timeline?.timeline?.instructions,
      data.user?.result?.timeline_v2?.timeline?.instructions,
      data.user?.result?.timeline?.timeline?.instructions,
      data.timeline?.instructions,
      data.bookmark_folder?.timeline?.instructions,
      data.list?.tweets_timeline?.timeline?.instructions,
      data.favorites_timeline?.instructions
    ].filter(p => Array.isArray(p));

    paths.forEach(p => {
      // 这里的 processInstructions 会正确返回是否发生了“有效”修改
      if (processInstructions(p)) changed = true;
    });

    if (changed) {
      const finalBody = JSON.stringify(json);
      console.log(`[X净化] 处理成功！输出体积: ${(finalBody.length / 1024).toFixed(2)} KB`);
      $done({ body: finalBody });
    } else {
      // 如果触发了空保护（返回 false），这里就会跳过 JSON.stringify，节约性能
      $done({ body: rawBody });
    }
  } catch (err) {
    console.log(`[X净化] 异常: ${err.message}`);
    $done({ body: $response.body });
  }
})();