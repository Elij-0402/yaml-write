from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import List, Optional
import instructor
from openai import OpenAI
import asyncio

# Import schemas from schemas.py
from api.schemas import Character, Relationship, ChapterAnalysis, OutlineInput, GenerationInput

### Create FastAPI instance with custom docs and openapi url
app = FastAPI(docs_url="/api/py/docs", openapi_url="/api/py/openapi.json")

class TestConnectionInput(BaseModel):
    apiKey: str
    baseUrl: str
    model: str

class ParseChapterInput(BaseModel):
    title: str
    content: str
    apiKey: str
    baseUrl: str
    model: str
    temperature: float = 0.7

@app.get("/api/py/helloFastApi")
def hello_fast_api():
    return {"message": "Hello from FastAPI"}

@app.post("/api/py/test-connection")
def test_connection(data: TestConnectionInput):
    try:
        client = OpenAI(
            api_key=data.apiKey,
            base_url=data.baseUrl
        )
        # Send a tiny query to test connectivity
        response = client.chat.completions.create(
            model=data.model,
            messages=[{"role": "user", "content": "Hello. Response with 'ok'."}],
            max_tokens=10
        )
        return {"success": True, "message": "Connection successful!"}
    except Exception as e:
        return {"success": False, "message": str(e)}

@app.post("/api/py/parse-chapter")
def parse_chapter(data: ParseChapterInput):
    try:
        client = instructor.from_openai(
            OpenAI(
                api_key=data.apiKey,
                base_url=data.baseUrl
            )
        )
        
        system_prompt = (
            "你是一个专业的小说分析助手。请分析给定的章节标题与内容，提取出世界观设定、出场角色列表、人物关系网络、核心故事骨架以及叙事风格与基调。\n"
            "对于出场角色，必须提取出详细的名字、性格、外貌特征、核心矛盾冲突以及出场章节。\n"
            "对于人物关系，必须提取出角色A、角色B以及关系描述。"
        )
        
        user_prompt = f"章节标题: {data.title}\n\n章节内容:\n{data.content}"
        
        response = client.chat.completions.create(
            model=data.model,
            response_model=ChapterAnalysis,
            temperature=data.temperature,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ]
        )
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/py/generate-outline")
async def generate_outline(data: OutlineInput):
    try:
        client = OpenAI(
            api_key=data.apiKey,
            base_url=data.baseUrl
        )
        
        system_prompt = (
            "你是一个顶尖的网文作家和小说创意架构师。你擅长将不同的故事设定、角色和剧情线进行完美、有机的融合，创造出令人惊叹的新创意大纲。\n"
            "你的任务是根据用户提供的多部小说/章节解析信息以及融合指令，生成一份极具创意、条理清晰的【融合小说新大纲】。\n"
            "新大纲必须采用 Markdown 格式，且包含以下内容：\n"
            "1. 新小说的核心世界观与设定（融合两者的闪光点）\n"
            "2. 融合后的主要角色表及核心人物关系\n"
            "3. 全新的核心冲突与故事主线\n"
            "4. 细化到具体前几章的分章剧情大纲与爆点设计\n\n"
            "请确保生成的内容充满想象力，逻辑自洽，节奏感极佳，直接输出 Markdown 文本，不要有任何无关的前言或后记。"
        )
        
        chapters_context = ""
        for idx, chap in enumerate(data.selectedChapters):
            chapters_context += f"--- 章节样本 {idx + 1} ---\n"
            chapters_context += f"世界观: {chap.get('worldview', '')}\n"
            chapters_context += f"核心骨架: {chap.get('plotSkeleton', '')}\n"
            chapters_context += f"风格: {chap.get('style', '')}\n"
            chapters_context += "出场角色:\n"
            for char in chap.get('characters', []):
                chapters_context += f"- {char.get('name')}: 性格={char.get('personality')}, 外貌={char.get('appearance')}, 冲突={char.get('coreConflict')}\n"
            chapters_context += "角色关系:\n"
            for rel in chap.get('relationships', []):
                chapters_context += f"- {rel.get('roleA')} 与 {rel.get('roleB')}: {rel.get('description')}\n"
            chapters_context += "\n"
            
        user_prompt = (
            f"下面是供你融合的现有小说章节结构化解析信息：\n\n"
            f"{chapters_context}\n"
            f"作家的融合指令/要求如下：\n"
            f"【{data.fusionPrompt}】\n\n"
            f"请根据上述信息，为我生成精美的融合大纲。"
        )
        
        def event_generator():
            try:
                response = client.chat.completions.create(
                    model=data.model,
                    temperature=data.temperature,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    stream=True
                )
                for chunk in response:
                    content = chunk.choices[0].delta.content
                    if content:
                        yield content
            except Exception as e:
                yield f"\n[Error during generation: {str(e)}]"

        return StreamingResponse(event_generator(), media_type="text/event-stream")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/py/generate-text")
async def generate_text(data: GenerationInput):
    try:
        client = OpenAI(
            api_key=data.apiKey,
            base_url=data.baseUrl
        )
        
        system_prompt = (
            "你是一个拥有十余年网文写作经验的白金作家，擅长细腻的心理描写、宏大的战斗场面、精妙的对话以及让人欲罢不能的爽点设计。\n"
            "你的任务是根据作家微调后的【融合新大纲】和【融合指令】，开始创作小说正文的第一章（或全新独立章节）。\n"
            "写作要求：\n"
            "1. 字数尽量丰满（建议生成 2000-3000 字左右的高水准正文），展开细节，描写画面感要强，避免平铺直叙地解释设定。\n"
            "2. 将大纲中的核心冲突、性格张力通过对话、行动和场景氛围真实表现出来。\n"
            "3. 直接输出小说的正式正文内容，不要有任何多余的开场白或自我介绍。"
        )
        
        user_prompt = (
            f"微调后的融合新大纲如下：\n\n"
            f"{data.outline}\n\n"
            f"当初的融合指令/要求：\n"
            f"【{data.fusionPrompt}】\n\n"
            f"请开始动笔创作这篇融合小说的第一章（或核心章节）正文。"
        )
        
        def event_generator():
            try:
                response = client.chat.completions.create(
                    model=data.model,
                    temperature=data.temperature,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt}
                    ],
                    stream=True
                )
                for chunk in response:
                    content = chunk.choices[0].delta.content
                    if content:
                        yield content
            except Exception as e:
                yield f"\n[Error during generation: {str(e)}]"

        return StreamingResponse(event_generator(), media_type="text/event-stream")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))