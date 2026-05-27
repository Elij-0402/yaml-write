from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import List, Optional
import instructor
from openai import OpenAI
import asyncio
import time

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
    start_time = time.time()
    try:
        api_key = data.apiKey.strip()
        base_url = data.baseUrl.strip()
        model_name = data.model.strip()
        
        # 创建限时的客户端
        client = OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=8.0
        )
        
        # 发送极小请求测试连通性
        response = client.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": "Ok"}],
            max_tokens=5
        )
        
        latency = int((time.time() - start_time) * 1000)
        return {
            "success": True, 
            "message": "连接成功！配置通道与流式响应握手正常。", 
            "latency": latency
        }
    except Exception as e:
        latency = int((time.time() - start_time) * 1000)
        err_str = str(e)
        friendly_msg = "连接失败，发生未知错误。"
        
        # 智能诊断翻译引擎
        if "401" in err_str or "AuthenticationError" in err_str or "invalid_api_key" in err_str:
            friendly_msg = "【API 密钥失效】请核对您的 API Key 是否正确填写，是否混入空格或多余字符。"
        elif "404" in err_str or "NotFoundError" in err_str or "model_not_found" in err_str:
            friendly_msg = "【接口路径或模型不匹配】当前 API 地址无法找到该模型，或接口根路径不正确。如 Ollama 本地未启动或未安装该模型。"
        elif "ConnectionRefused" in err_str or "ConnectionError" in err_str or "ConnectTimeout" in err_str or "Timeout" in err_str or "Failed to establish" in err_str:
            friendly_msg = "【网络超时/拒绝连接】无法建立与大模型服务端的连接。中国大陆官方直连可能受阻，请尝试使用国内代理中转地址，或检查科学上网代理软件设置。"
        elif "429" in err_str or "RateLimitError" in err_str or "insufficient_quota" in err_str:
            friendly_msg = "【限流或欠费】您的 API 账号额度已耗尽、已欠费，或请求并发超出了服务商限制，请登录服务商后台检查。"
        else:
            friendly_msg = f"【连接失败】{err_str}"
            
        return {
            "success": False,
            "message": friendly_msg,
            "latency": latency
        }

@app.post("/api/py/parse-chapter")
def parse_chapter(data: ParseChapterInput):
    import random
    max_retries = 3
    base_delay = 2.0
    
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
        
        for attempt in range(max_retries):
            try:
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
                err_str = str(e)
                if "429" in err_str or "RateLimit" in err_str or "quota" in err_str or "too many requests" in err_str.lower():
                    if attempt == max_retries - 1:
                        raise e
                    sleep_time = base_delay * (2 ** attempt) + random.uniform(0.1, 0.5)
                    time.sleep(sleep_time)
                else:
                    raise e
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
            
        bindings_context = ""
        if data.characterBindings:
            bindings_context += "\n=== ⚠️ 强制出场人物互动与融合规则 ===\n"
            bindings_context += "你必须严格在生成的大纲中实现以下指定角色之间的深度互动或融合配置：\n"
            for b in data.characterBindings:
                binding_desc = "灵魂融合 / 强力合体 (Merge settings)"
                if b.bindingType == "clash":
                    binding_desc = "宿命对决 / 终极宿敌 (Antagonists)"
                elif b.bindingType == "mentor":
                    binding_desc = "名师高徒 / 功法传承 (Mentor & Disciple)"
                elif b.bindingType == "custom":
                    binding_desc = f"自定义指定交互关系: {b.customDesc or '互动'}"
                
                bindings_context += f"- 把角色【{b.sourceChar}】与角色【{b.targetChar}】绑定为【{binding_desc}】。请在融合大纲的人物设定与故事走向中深度融合他们，并突出这种指定的纠葛摩擦。\n"
            bindings_context += "===================================\n\n"
            
        user_prompt = (
            f"下面是供你融合的现有小说章节结构化解析信息：\n\n"
            f"{chapters_context}\n"
            f"{bindings_context}"
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