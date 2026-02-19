// X (Twitter) 净化终极版 - 健壮性增强版
(function() {
  'use strict';

  // 1. 变量安全检查：防止 ReferenceError
  const hasResponse = (typeof $response !== 'undefined' && $response);
  const hasRequestBody = (typeof $request !== 'undefined' && $request && $request.body);

  if (!hasResponse || !$response.body) {
    // 如果没有响应体，直接安全退出，不抛出异常
    $done({});
    return;
  }

  const safeParse = (body) => { try { return JSON.parse(body); } catch (e) { return null; } };

  // 判定逻辑
  function isAd(entry) {
    if (!entry) return false;
    const entryId = entry.entryId || "";
    const itemContent = entry.content?.itemContent || entry.item?.itemContent;
    return /promoted|advert|sponsor/i.test(entryId) || 
           !!(itemContent?.promotedMetadata || itemContent?.promoted_metadata || itemContent?.promoted);
  }

  function isEssential(entry) {
    const entryId = entry.entryId || "";
    return /cursor|conversation|thread|reply|timeline-response/i.test(entryId);
  }

  function neutralize(entry) {
    return {
      entryId: entry.entryId,
      content: {
        entryType: "TimelineTimelineItem",
        __typename: "TimelineTimelineItem",
        itemContent: {
          __typename: "TimelineTweet",
          tweet_results: { result: { __typename: "TweetUnavailable", rest_id: "0" } }
        }
      }
    };
  }

  function processInstructions(instructions) {
    if (!Array.isArray(instructions)) return false;
    let isModified = false;
    instructions.forEach(ins => {
      if (ins.entries && Array.isArray(ins.entries)) {
        ins.entries = ins.entries.map(entry => {
          if (isEssential(entry)) return entry;
          if (isAd(entry)) { isModified = true; return neutralize(entry); }
          return entry;
        });
      }
    });
    return isModified;
  }

  try {
    const rawBody = $response.body;
    const json = safeParse(rawBody);

    if (!json) {
      // 记录体积，帮助判断是否被截断
      console.log(`[X净化] 无法解析JSON(可能被截断)。体积: ${(rawBody.length / 1024).toFixed(2)} KB`);
      $done({ body: rawBody });
      return;
    }

    let changed = false;
    const data = json.data || {};
    const paths = [
      data.home?.home_timeline_urt?.instructions,
      data.threaded_conversation_with_injections_v2?.instructions,
      data.search_by_raw_query?.search_timeline?.timeline?.instructions,
      data.user?.result?.timeline_v2?.timeline?.instructions,
      data.timeline?.instructions
    ];

    paths.forEach(p => { if (processInstructions(p)) changed = true; });

    if (changed) {
      const finalBody = JSON.stringify(json);
      console.log(`[X净化] 处理成功！输出体积: ${(finalBody.length / 1024).toFixed(2)} KB`);
      $done({ body: finalBody });
    } else {
      $done({ body: rawBody });
    }
  } catch (err) {
    console.log(`[X净化] 内部执行异常: ${err}`);
    $done({ body: $response ? $response.body : "" });
  }
})();
