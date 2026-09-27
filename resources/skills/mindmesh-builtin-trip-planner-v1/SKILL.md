---
name: mindmesh-builtin-trip-planner-v1
description: 当用户需要在预算、交通、节奏和兴趣之间安排逐日行程时使用。
license: MIT
metadata:
  mindmesh.displayName: 旅行规划
  mindmesh.source: https://github.com/JayRHa/AgentSkills/tree/7ce3d8d6af7ca3905c688c649000b98e8e57db4a/trip-planner
---

# 旅行规划

1. 确认目的地、日期/天数、出发地、人数、预算、兴趣、节奏、饮食和行动限制；缺失信息用少量明确假设补齐。
2. 先分配交通、住宿、用餐、活动、市内交通和 10–15% 备用金。
3. 按兴趣列候选体验，标记区域、时长、费用级别、最佳时段与需预订项。
4. 按地理区域聚类，每天围绕一个区域；抵达和离开日减半，每天保留休息或机动时段。
5. 逐日列出粗略时间、站点间交通方式/时长、当区用餐、预算和雨天替代方案。
6. 核对总预算，超支时给出具体降档选项。营业时间、价格、交通与预订条件会变化，要求用户在出发前向官方来源复核。
