import { BackendError } from "../util.js";

/**
 * FLUX.1-schnell on a Kaggle GPU: a documented stub, on purpose.
 *
 * Kaggle has no live inference API. Making one picture means pushing a batch kernel,
 * waiting for it to start, load the model, render and finish, then downloading its output.
 * Measured on the existing FLUX kernels (see README.md):
 *
 *   fixed cost per session (pins, 33.7 GB weights download, text encoders, transformer load)  about 6.5 min
 *   one picture at 1024x1024                                                                  about 20 s
 *   a push, end to end                                                                        about 8 min, plus queue time
 *
 * Parallax stops waiting on a picture 10 minutes after the job starts (a constant in its
 * worker, not a setting), so a push would sit right at the limit and fail on any queue delay.
 * The quota makes it worse: 2 concurrent GPU sessions and about 30 GPU hours a week are
 * shared with the team's other kernels, so one slow picture per request would crowd out
 * the batch art runs the team depends on.
 *
 * So this backend refuses honestly instead of pretending. With KAGGLE_FLUX unset (the
 * default), FLUX model ids are served by an AI Horde FLUX model when one is online, or an
 * SDXL-class model otherwise. If you set KAGGLE_FLUX=1 you get this error until a batching
 * design exists (collect pictures for several minutes, push one kernel, answer them all),
 * and that design needs Parallax's 10 minute limit raised.
 */
export class KaggleBackend {
  get configured() {
    return false;
  }

  async generate() {
    throw new BackendError(
      "The Kaggle FLUX backend is not available: a Kaggle run takes about 8 minutes and Parallax stops waiting after 10. " +
        "Unset KAGGLE_FLUX to use the AI Horde instead.",
    );
  }
}
