import os
from pathlib import Path

from argostranslate import package, translate
from faster_whisper import WhisperModel


argos_dir = Path(os.environ["ARGOS_PACKAGES_DIR"])
argos_dir.mkdir(parents=True, exist_ok=True)

package.update_package_index()
available = package.get_available_packages()
english_chinese = next(item for item in available if item.from_code == "en" and item.to_code == "zh")
if translate.get_translation_from_codes("en", "zh") is None:
    package.install_from_path(english_chinese.download())

# Trigger the sentence-boundary model download during the image build.
translator = translate.get_translation_from_codes("en", "zh")
translator.translate("Model installation check.")

# Download the speech-recognition model during the image build as well.
WhisperModel("tiny.en", device="cpu", compute_type="int8")
