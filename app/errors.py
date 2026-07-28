"""One error shape for the whole API: ``{"error": "..."}`` with a real status code."""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message
