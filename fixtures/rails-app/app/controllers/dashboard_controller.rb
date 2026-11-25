class DashboardController < ApplicationController
  def update
    flash[:notice] = "Profile updated successfully"
    redirect_to dashboard_path
  end
end
