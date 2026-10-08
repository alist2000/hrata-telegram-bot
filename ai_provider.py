"""
AI Provider module — wraps the free Gemini API.
Easy to swap for Groq, HuggingFace, or any other provider.
"""

import google.generativeai as genai
import os
from dotenv import load_dotenv

load_dotenv()

# Configure on import
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
MAX_RESPONSE_TOKENS = int(os.getenv("MAX_RESPONSE_TOKENS", "500"))

# System prompt to keep answers short and focused
SYSTEM_PROMPT = """You are a helpful AI assistant in a Telegram bot.
Rules:
- Keep answers SHORT and concise (max 2-3 paragraphs).
- Be friendly and helpful.
- If a question is too complex, give a brief summary and suggest the user research further.
- Do NOT answer anything illegal, harmful, or inappropriate.
- Answer in the SAME language the user asks in.
"""


def configure_gemini():
    """Initialize the Gemini client."""
    if not GEMINI_API_KEY:
        raise ValueError(
            "❌ GEMINI_API_KEY is not set! Get a free key at https://aistudio.google.com/apikey"
        )
    genai.configure(api_key=GEMINI_API_KEY)


async def ask_gemini(question: str) -> tuple[str, int]:
    """
    Send a question to Google Gemini and return (answer, tokens_used).

    Uses gemini-2.0-flash (free tier: 15 RPM, 1M tokens/day).
    """
    try:
        model = genai.GenerativeModel(
            model_name="gemini-2.0-flash",
            system_instruction=SYSTEM_PROMPT,
            generation_config=genai.types.GenerationConfig(
                max_output_tokens=MAX_RESPONSE_TOKENS,
                temperature=0.7,
            ),
        )

        response = await model.generate_content_async(question)

        answer = response.text.strip()
        # Estimate tokens (Gemini doesn't always return exact count in free tier)
        tokens = len(answer.split()) * 2  # rough estimate
        return answer, tokens

    except Exception as e:
        error_msg = str(e)
        if "429" in error_msg or "quota" in error_msg.lower():
            return "⏳ The AI service is temporarily rate-limited. Please try again in a minute.", 0
        elif "safety" in error_msg.lower():
            return "⚠️ I can't answer that question due to safety guidelines.", 0
        else:
            print(f"❌ Gemini error: {e}")
            return "❌ Sorry, something went wrong with the AI service. Please try again later.", 0
