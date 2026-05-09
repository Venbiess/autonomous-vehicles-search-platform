from __future__ import annotations

import logging

from transformers import logging as transformers_logging

logger = logging.getLogger("avsp.hf")


def configure_hf_download_logging(enable_progress: bool) -> None:
    if enable_progress:
        transformers_logging.enable_progress_bar()
        # Keep tqdm progress bars, but suppress model/tokenizer and init warnings.
        transformers_logging.set_verbosity_error()
    else:
        transformers_logging.disable_progress_bar()
        transformers_logging.set_verbosity_error()

    try:
        from huggingface_hub.utils import disable_progress_bars
        from huggingface_hub.utils import enable_progress_bars

        if enable_progress:
            enable_progress_bars()
        else:
            disable_progress_bars()
    except Exception:
        # huggingface_hub may be unavailable in thin local environments
        pass

    try:
        from huggingface_hub.utils import logging as hf_hub_logging

        # Progress bars do not require verbose hub logs.
        hf_hub_logging.set_verbosity_error()
    except Exception:
        pass

    # Suppress noisy model-library informational logs while keeping errors.
    logging.getLogger("sentence_transformers").setLevel(logging.WARNING)
    logging.getLogger("transformers").setLevel(logging.ERROR)

    logger.info("Hugging Face download progress enabled=%s", enable_progress)
