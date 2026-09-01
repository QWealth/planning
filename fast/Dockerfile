FROM public.ecr.aws/lambda/python:3.9

# 3.9 and not something newer, deliberately: the local venv this was written and
# tested against is 3.9.6, and the code uses PEP 585 builtin generics (dict[str, Any],
# list[str]) which are evaluated at import time by Pydantic. Those work from 3.9 on.
# What is NOT used anywhere in app/ is the 3.10 union syntax (X | None), which would
# raise TypeError at import here. Keep it that way or bump this image first.

COPY requirements.txt ${LAMBDA_TASK_ROOT}
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY app/ ${LAMBDA_TASK_ROOT}/app

# Mangum wraps the FastAPI app; see the bottom of app/main.py.
CMD [ "app.main.handler" ]
