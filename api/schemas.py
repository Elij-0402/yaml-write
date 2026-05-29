from pydantic import BaseModel, Field
from typing import List

class Character(BaseModel):
    name: str = Field(..., description="角色的姓名")
    personality: str = Field(..., description="角色的性格特征、脾气秉性")
    appearance: str = Field(..., description="角色的外貌、穿着、体型等特征")
    coreConflict: str = Field(..., description="角色的核心矛盾冲突、内在驱动力")
    chapters: str = Field(..., description="角色主要出场的章节")

class Relationship(BaseModel):
    roleA: str = Field(..., description="角色A姓名")
    roleB: str = Field(..., description="角色B姓名")
    description: str = Field(..., description="角色A与角色B之间的关系描述（如：师徒、情侣、劲敌）")

class ChapterAnalysis(BaseModel):
    worldview: str = Field(..., description="本章展现或补充的世界观设定、背景设定、特殊规则")
    plotSkeleton: str = Field(..., description="本章的核心剧情走向、骨架、转折点")
    characters: List[Character] = Field(..., description="本章出场的角色及其详细设定列表")
    relationships: List[Relationship] = Field(..., description="本章中体现或发生变化的角色关系网络")
    style: str = Field(..., description="本章展现出的叙事风格、语言特色、基调（如：冷峻、幽默、热血）")

class OutlineInput(BaseModel):
    selectedChapters: List[dict] = Field(..., description="选中的多章解析结构列表")
    fusionPrompt: str = Field(..., description="用户的融合指令/要求")
    apiKey: str = Field(..., description="大模型 API 密钥")
    baseUrl: str = Field(..., description="大模型 API Base URL")
    model: str = Field(..., description="所选的模型名称")
    temperature: float = Field(0.7, ge=0.0, le=1.5, description="采样温度")

class GenerationInput(BaseModel):
    outline: str = Field(..., description="微调后的融合大纲")
    fusionPrompt: str = Field(..., description="用户的融合指令/要求")
    apiKey: str = Field(..., description="大模型 API 密钥")
    baseUrl: str = Field(..., description="大模型 API Base URL")
    model: str = Field(..., description="所选的模型名称")
    temperature: float = Field(0.7, ge=0.0, le=1.5, description="采样温度")
