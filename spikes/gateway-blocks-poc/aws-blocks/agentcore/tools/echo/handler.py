def handler(event, context):
    text = event.get("text", "")
    return {"echoed": text}
