import re

STOPWORDS = {"you", "with", "too", "but", "dont", "through", "the", "and",
             "a", "an", "to", "of", "in", "it", "is", "was", "for", "on",
             "at", "this", "that", "be", "anyone", "either", "whatever",
             "next", "between", "need", "bit", "feel", "feeling",
             "not", "no", "very", "really", "so", "just", "also", "its",
             "unfortunately", "definitely", "absolutely", "highly", "totally",
             "actually", "quite", "pretty", "overall"}
MIN_SCORE = 0.02
END_PUNCT = ".,!?;:"

def pick_word(shap_list):
    """Return the top meaningful word from a SHAP list, or None."""
    for item in shap_list or []:
        w = item["word"].lower()
        if item["score"] >= MIN_SCORE and w not in STOPWORDS and len(w) > 2:
            return item["word"]
    return None

def make_snippet(text, word, window=4):
    """Return about 4 words either side of the word, with <mark> around it."""
    words = text.split()
    for i, w in enumerate(words):
        clean = re.sub(r"\W", "", w)
        if clean.lower() == word.lower():
            start, end = max(0, i - window), min(len(words), i + window + 1)
            words[i] = w.replace(clean, "<mark>" + clean + "</mark>")
            snippet = " ".join(words[start:end])
            if end < len(words):
                snippet = snippet.rstrip(END_PUNCT) + "…"
            if start > 0:
                snippet = "…" + snippet
            return snippet
    return None
