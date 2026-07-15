"""
Confidence vs. Grammar module (US-21 / PDF US-053).

Computes confidence_score from FluencyAnalyzer's audio delivery signals and
grammar_score from GrammarCorrector's error_density, then generates the
confidence-first feedback strategy defined by US-21.

Scoring reuses FluencyAnalyzer's OWN established point bands (speech rate,
pause frequency, filled pauses) rather than inventing a new weighting
scheme — see _calculate_confidence_score() docstring for exactly which
existing bands are reused and why lexical diversity is excluded.

US-21 Acceptance Criteria covered here:
  - Primary displayed metric is confidence_score, never a grammar accuracy %.
  - Minor grammar errors are demoted to a secondary "Minor Polish" tier
    rather than being flagged as critical failures (grammar_tier).
  - E-01 (Unintelligible Grammar): breaks from confidence-first model to
    request clarification instead of silently scoring.
  - E-02 (Professional Context Violation): grammar threshold tightens for
    high-stakes contexts (is_high_stakes_context).
  - E-03 (Repeat Grammatical Offender): after 10+ repeats of the same
    error tag, surface one actionable tip in the feedback summary WITHOUT
    tanking confidence_score. Implemented in _detect_repeat_offender().
"""

import logging
from collections import Counter
from typing import Dict, List, Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ConfidenceGrammarAnalyzer:
    """
    Confidence-vs-grammar scoring and feedback for US-21.

    Reuses FluencyAnalyzer output (speech_rate, pause_count,
    mean_pause_duration, filled_pauses) and GrammarCorrector output
    (error_density, and optionally error_tags — see analyze() docstring).
    Does not re-derive any audio/text signal itself.
    """

    # --- Classification thresholds -----------------------------------
    # NOT specified anywhere in the PDF spec (US-053 gives no numeric
    # cutoffs). These are placeholder judgment calls needed to turn a
    # continuous 0-100 score into the label/tier US-21 requires.
    # TODO: replace with values from whoever owns scoring calibration,
    # or make these configurable (e.g. via a settings/config module)
    # instead of class constants, once one exists.
    UNINTELLIGIBLE_GRAMMAR_THRESHOLD = 20.0
    GRAMMAR_THRESHOLD_DEFAULT = 60.0
    GRAMMAR_THRESHOLD_HIGH_STAKES = 75.0

    # --- E-03: Repeat Grammatical Offender ----------------------------
    # PDF wording: "The user makes the exact same tense error 10 times in
    # a session." Read as >=10 occurrences of the SAME error tag.
    REPEAT_OFFENDER_THRESHOLD = 10

    # Maps a grammar error tag (as produced by whatever tags
    # GrammarCorrector/spaCy analysis attaches to a correction) to the
    # actionable tip surfaced once the threshold is hit. NOT specified
    # in the PDF beyond the single worked example ("Review Past Tense
    # Verbs") — this list is a best-effort starting set and should be
    # extended/confirmed once GrammarCorrector actually emits tags.
    # TODO(E-03 dependency): grammar.py's correct_text() currently only
    # returns error_density (a float), not per-error tags. Until
    # grammar.py is extended to emit something like
    # spacy_analysis['error_tags'] = ['past_tense', ...], callers must
    # pass tags in explicitly via the current_error_tags argument below.
    ERROR_TAG_TIPS = {
        "past_tense": "Review Past Tense Verbs",
        "subject_verb_agreement": "Review Subject-Verb Agreement",
        "article_usage": "Review Article Usage (a/an/the)",
        "preposition": "Review Preposition Choice",
        "plural_form": "Review Plural Noun Forms",
    }

    def analyze(
        self,
        fluency_details: Dict[str, any],
        grammar_result: Dict[str, any],
        is_high_stakes_context: bool = False,
        error_history: Optional[List[str]] = None,
        current_error_tags: Optional[List[str]] = None,
    ) -> Dict[str, any]:
        """
        Score confidence vs. grammar and produce US-21 feedback.

        Args:
            fluency_details: Output of FluencyAnalyzer.analyze_fluency()
                (pipeline.py's result['fluency_details']).
            grammar_result: Output of GrammarCorrector.correct_text()
                (pipeline.py's result['grammar_errors'] source).
            is_high_stakes_context: True for formal/professional practice
                contexts, tightening the grammar threshold (E-02).
            error_history: Optional list of error tags accumulated so far
                THIS session (e.g. ["past_tense", "past_tense", ...]).
                Caller (pipeline.py) is responsible for persisting this
                list across turns — no DB/session layer exists in this
                module set, so it must be passed in and the updated list
                returned each call (see 'error_history' in the result).
            current_error_tags: Error tag(s) detected in THIS turn's
                correction, if the caller has them (e.g. from an
                upstream tagging step). Appended to error_history before
                repeat-offender detection runs. Safe to omit if no
                tagging is available yet.

        Returns:
            Dict with confidence_score, grammar_score, primary_metric
            (always "confidence_score" per US-21 acceptance criteria),
            grammar_tier, needs_clarification, feedback_hint,
            repeat_offender_tip (None unless E-03 threshold is hit this
            call), and error_history (updated, for the caller to persist).
        """
        confidence_score = self._calculate_confidence_score(fluency_details or {})
        error_density = (grammar_result or {}).get("error_density", 0.0)
        grammar_score = round(100.0 * (1.0 - min(1.0, max(0.0, error_density))), 1)

        grammar_threshold = (
            self.GRAMMAR_THRESHOLD_HIGH_STAKES
            if is_high_stakes_context
            else self.GRAMMAR_THRESHOLD_DEFAULT
        )

        if grammar_score < self.UNINTELLIGIBLE_GRAMMAR_THRESHOLD:
            # E-01: Unintelligible Grammar — break from confidence-first
            # model entirely and ask for clarification.
            grammar_tier = "unintelligible"
            needs_clarification = True
            feedback_hint = "I didn't quite understand that. Are you trying to say...?"
        else:
            needs_clarification = False
            grammar_tier = "minor_polish" if grammar_score >= grammar_threshold else "needs_attention"
            feedback_hint = self._build_feedback_hint(grammar_tier, is_high_stakes_context)

        # E-03: Repeat Grammatical Offender. Runs regardless of tier —
        # even a "minor_polish" session should surface the tip once the
        # same tag has repeated enough, per the PDF's exception handling.
        updated_history = list(error_history) if error_history else []
        if current_error_tags:
            updated_history.extend(current_error_tags)

        repeat_offender_tip = self._detect_repeat_offender(updated_history)

        result = {
            "confidence_score": confidence_score,
            "grammar_score": grammar_score,
            "primary_metric": "confidence_score",
            "grammar_tier": grammar_tier,
            "needs_clarification": needs_clarification,
            "feedback_hint": feedback_hint,
            "repeat_offender_tip": repeat_offender_tip,
            "error_history": updated_history,
        }

        logger.info(
            "Confidence/grammar: confidence=%.1f grammar=%.1f tier=%s repeat_tip=%s",
            confidence_score,
            grammar_score,
            grammar_tier,
            repeat_offender_tip,
        )
        return result

    def _detect_repeat_offender(self, error_history: List[str]) -> Optional[str]:
        """
        E-03: Repeat Grammatical Offender.

        If any single error tag has occurred REPEAT_OFFENDER_THRESHOLD or
        more times in error_history, return one actionable tip for it.
        Importantly, this NEVER touches confidence_score or grammar_score
        — per the PDF resolution, the tip is logged in the feedback
        summary "without tanking the overarching Confidence Score."

        Only the single most frequent qualifying tag is surfaced per call
        (the PDF's example is singular: "a specific actionable tip"), not
        one tip per offending tag, to avoid overwhelming the learner.

        Args:
            error_history: All error tags seen so far this session,
                including the current turn's tags if any.

        Returns:
            An actionable tip string, or None if no tag has hit the
            repeat threshold yet.
        """
        if not error_history:
            return None

        counts = Counter(error_history)
        tag, count = counts.most_common(1)[0]

        if count < self.REPEAT_OFFENDER_THRESHOLD:
            return None

        tip = self.ERROR_TAG_TIPS.get(tag)
        if tip is None:
            # Unknown tag — still surface something rather than silently
            # dropping a qualifying repeat offender.
            tip = f"Review {tag.replace('_', ' ').title()}"

        return tip

    def _calculate_confidence_score(self, fluency_details: Dict[str, any]) -> float:
        """
        Derive confidence_score (0-100) from audio delivery signals only.

        Reuses the exact point bands FluencyAnalyzer._calculate_overall_score
        already uses for speech_rate (40 pts), pause frequency (20 pts), and
        filled_pauses (20 pts) — no new weights invented. FluencyAnalyzer's
        4th component, lexical_diversity (20 pts), is excluded here per the
        US-21 design decision: confidence must come from delivery signals,
        not vocabulary/text richness. The remaining 80-point raw total is
        rescaled to 0-100.
        """
        if not fluency_details:
            return 0.0

        raw = 0.0

        # Speech rate (40 pts) — identical bands to fluency.py.
        speech_rate = fluency_details.get("speech_rate", 0.0)
        if 2.0 <= speech_rate <= 4.0:
            raw += 40.0
        elif 1.5 <= speech_rate <= 5.0:
            raw += 30.0
        elif speech_rate > 0:
            raw += 20.0

        # Pause frequency (20 pts) — identical bands to fluency.py.
        pause_count = fluency_details.get("pause_count", 0)
        if pause_count == 0:
            raw += 20.0
        elif pause_count <= 2:
            raw += 15.0
        elif pause_count <= 5:
            raw += 10.0
        else:
            raw += 5.0

        # Filled pauses (20 pts) — identical bands to fluency.py.
        filled_pauses = fluency_details.get("filled_pauses", 0)
        if filled_pauses == 0:
            raw += 20.0
        elif filled_pauses <= 1:
            raw += 15.0
        elif filled_pauses <= 3:
            raw += 10.0
        else:
            raw += 5.0

        # Rescale from /80 (three components) to /100.
        return round(min(100.0, max(0.0, raw / 80.0 * 100.0)), 1)

    def _build_feedback_hint(self, grammar_tier: str, is_high_stakes_context: bool) -> str:
        """Build the confidence-first feedback sentence."""
        if grammar_tier == "minor_polish":
            return "Your message came through clearly. Grammar is solid too — keep it up."

        hint = "Your message came through clearly, with a few grammar points as minor polish."
        if is_high_stakes_context:
            hint += " In professional writing, tighten these up before sending."
        return hint