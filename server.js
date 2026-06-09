require('dotenv').config({ path: './openai_key.env' });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
const MEALS_FILE = path.join(__dirname, 'meals.json');
const NAVER_MAP_KEY = 'aqHFVhoEry97EdL9xG0hsyMWEBtRUygB0YJFFLsW';

// ── Meal storage helpers ──────────────────────────────────────────
function loadMeals() {
  if (!fs.existsSync(MEALS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(MEALS_FILE, 'utf-8')); }
  catch { return []; }
}

function saveMeals(meals) {
  fs.writeFileSync(MEALS_FILE, JSON.stringify(meals, null, 2));
}

function getRecentMeals() {
  const meals = loadMeals();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 3);
  return meals.filter(m => new Date(m.date) >= cutoff);
}

function addMeal(meal) {
  const meals = loadMeals();
  meals.push({ ...meal, savedAt: new Date().toISOString() });
  saveMeals(meals);
  return true;
}

// ── Tool definitions ──────────────────────────────────────────────
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_recent_meals',
      description: '최근 3일간 먹은 식사 기록을 조회한다. 추천 전에 반드시 호출해 중복을 피한다.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_meal',
      description: '사용자가 먹기로 결정한 식사를 기록한다.',
      parameters: {
        type: 'object',
        properties: {
          date:      { type: 'string', description: 'YYYY-MM-DD 형식' },
          meal_time: { type: 'string', enum: ['아침', '점심', '저녁', '야식'] },
          place:     { type: 'string', description: '가게 이름' },
          menu:      { type: 'string', description: '먹은 메뉴' }
        },
        required: ['date', 'meal_time', 'place', 'menu']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_naver_map_link',
      description: '가게 이름으로 네이버 지도 검색 URL을 생성한다.',
      parameters: {
        type: 'object',
        properties: {
          place_name: { type: 'string', description: '검색할 가게 이름' }
        },
        required: ['place_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: '현재 날짜, 시간, 요일을 반환한다.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
];

// ── Tool executor ─────────────────────────────────────────────────
function executeTool(name, args) {
  switch (name) {
    case 'get_recent_meals':
      return JSON.stringify(getRecentMeals());

    case 'save_meal':
      addMeal(args);
      return JSON.stringify({ success: true, message: '식사 기록이 저장됐어요!' });

    case 'generate_naver_map_link': {
      const query = encodeURIComponent(`${args.place_name} 능동`);
      return JSON.stringify({
        url: `https://map.naver.com/p/search/${query}`,
        place_name: args.place_name
      });
    }

    case 'get_current_datetime': {
      const now = new Date();
      const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
      return JSON.stringify({
        date: now.toISOString().split('T')[0],
        time: now.toTimeString().slice(0, 5),
        weekday: weekdays[now.getDay()],
        hour: now.getHours()
      });
    }

    default:
      return JSON.stringify({ error: 'Unknown tool' });
  }
}

// ── System prompt ─────────────────────────────────────────────────
function buildSystemPrompt() {
  return `너는 광진구 능동에 사는 자취생의 식사 메뉴 추천 AI야. 이름은 "냠냠이"야.

## 규칙
- 대화를 시작하면 get_current_datetime과 get_recent_meals를 먼저 호출해 현재 상황을 파악해.
- 능동 기준 도보 10분 이내(약 800m) 식당만 추천해. (예: 능동 먹자골목, 화양동, 군자동 일대)
- 최근 3일간 먹은 음식은 반드시 피해.
- 추천 전에 대화로 자연스럽게 파악해:
  → 식사 시간대 (이미 알면 생략)
  → 예산
  → 인원 (혼밥/같이)
  → 기피 음식 또는 오늘 당기는 것
- 질문은 한 번에 하나씩만 해. 여러 개 한꺼번에 묻지 마.

## 추천 형식
추천할 때는 반드시 generate_naver_map_link를 호출해 링크를 포함해.
각 추천을 아래 형식으로 정확히 출력해:

[RESTAURANT]
name: 가게이름
menu: 추천메뉴
reason: 추천 이유 (한 줄)
link: {generate_naver_map_link 결과 URL}
[/RESTAURANT]

추천은 2~3개 제시해.

## 식사 확정
사용자가 특정 가게를 선택하거나 "여기서 먹을게", "이거 먹을게" 같은 말을 하면 save_meal을 호출해 기록해.
저장 후엔 "맛있게 드세요! 🍽️" 처럼 짧게 응답해.

## 말투
- 친근하고 자연스러운 한국어
- 너무 길게 설명하지 말고 핵심만
- 이모지 적당히 사용`;
}

// ── Chat endpoint (로컬: /chat 및 /api/chat 둘 다 지원) ───────────
async function handleChat(req, res) {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages 필드가 필요합니다.' });
  }

  const systemMessage = { role: 'system', content: buildSystemPrompt() };
  let allMessages = [systemMessage, ...messages];

  try {
    // Function calling loop
    while (true) {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: allMessages,
        tools,
        tool_choice: 'auto'
      });

      const message = response.choices[0].message;
      allMessages.push(message);

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const result = executeTool(toolCall.function.name, args);
          allMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          });
        }
        continue;
      }

      // Final text response
      return res.json({
        reply: message.content,
        messages: allMessages.slice(1)
      });
    }
  } catch (err) {
    console.error('OpenAI error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

app.post('/chat', handleChat);
app.post('/api/chat', handleChat);

// ── Naver map key endpoint ────────────────────────────────────────
app.get('/config', (req, res) => {
  res.json({ naverMapKey: NAVER_MAP_KEY });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🍽️  능동 밥집 추천 서버 실행 중: http://localhost:${PORT}`);
});
