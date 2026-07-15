from fastapi import APIRouter

from middlewares.auth_middleware import require_auth
from services.user_service import (
    get_profile,
    delete_account,
    list_users,
    update_profile,
    update_user_role,
)

router = APIRouter()

# Self-service (auth enforced via Depends(require_auth) on each handler)
# Protected routes (auth enforced via Depends(require_auth) on me() itself,
router.add_api_route("/me", get_profile, methods=["GET"])
router.add_api_route("/me", update_profile, methods=["PATCH"])
router.add_api_route("/me", delete_account, methods=["DELETE"])

# Admin-only (auth + role enforced via Depends(require_admin) on each handler)
router.add_api_route("/", list_users, methods=["GET"])
router.add_api_route("/{target_user_id}/role", update_user_role, methods=["PATCH"])
